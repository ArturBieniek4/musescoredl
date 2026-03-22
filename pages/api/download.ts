import type { NextApiRequest, NextApiResponse } from "next";
import { load } from "cheerio";
import { PDFDocument } from "pdf-lib";

/** Headers that mimic a real browser to bypass basic Cloudflare protection. */
const BROWSER_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept-Encoding": "gzip, deflate, br",
  "Cache-Control": "no-cache",
  Pragma: "no-cache",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Sec-Fetch-User": "?1",
  "Upgrade-Insecure-Requests": "1",
};

/** Fetch a URL with retries. */
async function fetchWithRetry(
  url: string,
  opts: RequestInit,
  retries = 2,
  delayMs = 1000
): Promise<Response> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, opts);
      if (res.ok || attempt === retries) return res;
    } catch (err) {
      if (attempt === retries) throw err;
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new Error("fetchWithRetry exhausted");
}

/** Extract score image URLs from a MuseScore page's HTML. */
function extractScoreImageUrls(html: string): string[] {
  const $ = load(html);

  const urls: string[] = [];

  // Primary selector: <img> elements whose title ends with "music notes"
  $('img[title$="music notes"]').each((_, el) => {
    const src = $(el).attr("src");
    if (src) urls.push(src);
  });

    // Fallback: look for PNG score images by src pattern (SVG excluded – not embeddable in PDF)
    if (urls.length === 0) {
      $("img[src]").each((_, el) => {
        const src = $(el).attr("src") ?? "";
        if (/score_\d+\.png/i.test(src)) {
          urls.push(src);
        }
      });
    }

  // Deduplicate while preserving order
  const seen = new Set<string>();
  return urls.filter((u) => {
    if (seen.has(u)) return false;
    seen.add(u);
    return true;
  });
}

/** Download an image and return its bytes. */
async function downloadImage(url: string): Promise<Uint8Array> {
  const res = await fetchWithRetry(
    url,
    {
      headers: {
        ...BROWSER_HEADERS,
        Referer: "https://musescore.com/",
      },
    },
    2,
    500
  );
  if (!res.ok) {
    throw new Error(`Failed to download image ${url}: HTTP ${res.status}`);
  }
  const buffer = await res.arrayBuffer();
  return new Uint8Array(buffer);
}

/** Build a PDF from an array of PNG and JPEG image byte arrays. */
async function buildPdf(imageBuffers: Uint8Array[]): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.create();

  for (const imgBytes of imageBuffers) {
    // Determine format by checking magic bytes
    const isPng =
      imgBytes[0] === 0x89 &&
      imgBytes[1] === 0x50 &&
      imgBytes[2] === 0x4e &&
      imgBytes[3] === 0x47;

    const isJpeg = imgBytes[0] === 0xff && imgBytes[1] === 0xd8;

    if (!isPng && !isJpeg) {
      throw new Error(
        "Unsupported image format encountered. Only PNG and JPEG score images are supported."
      );
    }

    let image;
    if (isPng) {
      image = await pdfDoc.embedPng(imgBytes);
    } else {
      image = await pdfDoc.embedJpg(imgBytes);
    }

    const { width, height } = image;
    const page = pdfDoc.addPage([width, height]);
    page.drawImage(image, { x: 0, y: 0, width, height });
  }

  return pdfDoc.save();
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const { url } = req.query;

  if (!url || typeof url !== "string") {
    res.status(400).json({ error: "Missing or invalid `url` query parameter." });
    return;
  }

  // Validate the URL is a MuseScore URL
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    res.status(400).json({ error: "Invalid URL." });
    return;
  }

  if (!["musescore.com", "www.musescore.com"].includes(parsedUrl.hostname)) {
    res.status(400).json({ error: "Only musescore.com URLs are supported." });
    return;
  }

  // ------------------------------------------------------------------
  // 1. Fetch the MuseScore page HTML
  // ------------------------------------------------------------------
  let html: string;
  try {
    const pageRes = await fetchWithRetry(
      url,
      { headers: BROWSER_HEADERS },
      2,
      1500
    );

    if (!pageRes.ok) {
      if (pageRes.status === 403 || pageRes.status === 503) {
        res.status(502).json({
          error:
            "MuseScore returned a Cloudflare challenge page. The score could not be fetched at this time. Please try again in a few seconds.",
        });
        return;
      }
      res.status(502).json({
        error: `MuseScore returned HTTP ${pageRes.status}. Please check the URL and try again.`,
      });
      return;
    }

    html = await pageRes.text();
  } catch (err) {
    console.error("Error fetching MuseScore page:", err);
    res.status(502).json({
      error: "Failed to reach musescore.com. Please try again.",
    });
    return;
  }

  // ------------------------------------------------------------------
  // 2. Extract score image URLs
  // ------------------------------------------------------------------
  const imageUrls = extractScoreImageUrls(html);

  if (imageUrls.length === 0) {
    res.status(404).json({
      error:
        "No score images found on this page. The score may be private, require a login, or the URL may be incorrect.",
    });
    return;
  }

  // ------------------------------------------------------------------
  // 3. Download all images
  // ------------------------------------------------------------------
  let imageBuffers: Uint8Array[];
  try {
    imageBuffers = await Promise.all(imageUrls.map(downloadImage));
  } catch (err) {
    console.error("Error downloading score images:", err);
    res.status(502).json({
      error: "Failed to download one or more score images. Please try again.",
    });
    return;
  }

  // ------------------------------------------------------------------
  // 4. Build PDF
  // ------------------------------------------------------------------
  let pdfBytes: Uint8Array;
  try {
    pdfBytes = await buildPdf(imageBuffers);
  } catch (err) {
    console.error("Error building PDF:", err);
    res.status(500).json({ error: "Failed to generate PDF. Please try again." });
    return;
  }

  // ------------------------------------------------------------------
  // 5. Serve the PDF
  // ------------------------------------------------------------------
  // Derive a filename from the URL path (e.g. /user/123/scores/456 → score-456.pdf)
  const scoreIdMatch = parsedUrl.pathname.match(/\/scores\/(\d+)/);
  const filename = scoreIdMatch ? `score-${scoreIdMatch[1]}.pdf` : "score.pdf";

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${filename}"`
  );
  res.setHeader("Content-Length", pdfBytes.length);
  res.setHeader("X-Page-Count", String(imageBuffers.length));
  res.status(200).send(Buffer.from(pdfBytes));
}
