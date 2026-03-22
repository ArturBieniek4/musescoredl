import type { NextApiRequest, NextApiResponse } from "next";

type CloudscraperRequestOptions = {
  uri: string;
  headers?: Record<string, string>;
  encoding?: null;
  resolveWithFullResponse?: boolean;
  simple?: boolean;
};

type CloudscraperResponse<TBody> = {
  statusCode: number;
  body: TBody;
  headers?: Record<string, string | string[] | undefined>;
};

type CloudscraperError = Error & {
  statusCode?: number;
  response?: {
    statusCode?: number;
    body?: unknown;
  };
};

type EmbeddedScorePlayerState = {
  config?: {
    releaseVer?: string;
    unified_id?: string;
  };
  store?: {
    jmuse_settings?: {
      score_player?: {
        isHasSVG?: boolean;
        urls?: {
          image_path?: string;
        };
        json?: {
          id?: number;
          dates?: {
            revised?: number;
          };
          metadata?: {
            pages?: number;
          };
        };
      };
    };
  };
};

type ExtractedScoreData = {
  imageUrls: string[];
  isHasSVG?: boolean;
  releaseVer?: string;
  scoreId?: number;
  unifiedId?: string;
};

const cloudscraper = require("cloudscraper") as {
  get<TBody = string>(
    options: CloudscraperRequestOptions
  ): Promise<CloudscraperResponse<TBody>>;
};

const { load } = require("cheerio") as {
  load: typeof import("cheerio").load;
};

const { PDFDocument } = require("pdf-lib") as {
  PDFDocument: typeof import("pdf-lib").PDFDocument;
};

const sharp = require("sharp") as typeof import("sharp");

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

/** Fetch a URL with retries through cloudscraper. */
async function requestWithRetry<TBody = string>(
  url: string,
  opts: Omit<CloudscraperRequestOptions, "uri">,
  retries = 2,
  delayMs = 1000
): Promise<CloudscraperResponse<TBody>> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await cloudscraper.get<TBody>({
        uri: url,
        resolveWithFullResponse: true,
        simple: false,
        ...opts,
      });
      if ((res.statusCode >= 200 && res.statusCode < 300) || attempt === retries) {
        return res;
      }
    } catch (err) {
      if (attempt === retries) throw err as CloudscraperError;
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new Error("requestWithRetry exhausted");
}

/** Extract score image URLs from a MuseScore page's HTML. */
async function resolveSecureImageUrl(
  scoreId: number,
  pageIndex: number,
  releaseVer: string,
  unifiedId: string
): Promise<string> {
  const authHeader = require("crypto")
    .createHash("md5")
    .update(`${scoreId}img${pageIndex}llfr`)
    .digest("hex")
    .slice(0, 4);

  const res = await requestWithRetry<string>(
    `https://musescore.com/api/jmuse?id=${scoreId}&type=img&index=${pageIndex}`,
    {
      headers: {
        Authorization: authHeader,
        "X-MU-FRONTEND-VER": releaseVer,
        "X-Mu-Unified-Id": unifiedId,
        Referer: "https://musescore.com/",
      },
    },
    2,
    500
  );

  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new Error(`Failed to resolve secure image URL: HTTP ${res.statusCode}`);
  }

  const payload = JSON.parse(res.body) as {
    info?: {
      url?: unknown;
    };
  };

  if (typeof payload.info?.url !== "string" || payload.info.url.length === 0) {
    throw new Error("Secure image response did not include a page URL");
  }

  return payload.info.url;
}

async function extractScoreImageUrls(html: string): Promise<ExtractedScoreData> {
  const $ = load(html);
  const dataAttributes = $("*")
    .toArray()
    .flatMap((el) => {
      if (!("attribs" in el) || !el.attribs) {
        return [];
      }

      return Object.entries(el.attribs);
    });
  const embeddedStore = dataAttributes
    .find(
      ([attrName, attrValue]) =>
        attrName.startsWith("data-") &&
        attrValue.includes("jmuse_settings") &&
        attrValue.includes("score_player")
    )?.[1];

  console.log("[download] extractScoreImageUrls", {
    totalAttributes: dataAttributes.length,
    foundEmbeddedStore: Boolean(embeddedStore),
  });

  if (embeddedStore) {
    try {
      const decodedStore = $("<textarea>").html(embeddedStore).text();
      const parsedStore = JSON.parse(decodedStore) as EmbeddedScorePlayerState;
      const scorePlayerSettings = parsedStore.store?.jmuse_settings?.score_player;
      const scorePlayer = scorePlayerSettings?.json;
      const imageUrls = scorePlayerSettings?.urls;
      const pageCount = scorePlayer?.metadata?.pages;
      const imagePath = imageUrls?.image_path;
      const revised = scorePlayer?.dates?.revised;
      const scoreId = scorePlayer?.id;
      const isHasSVG = scorePlayerSettings?.isHasSVG;
      const releaseVer = parsedStore.config?.releaseVer;
      const unifiedId = parsedStore.config?.unified_id;

      console.log("[download] embedded store values", {
        pageCount,
        imagePath,
        revised,
        scoreId,
        isHasSVG,
        releaseVer,
        unifiedId,
      });

      if (
        typeof pageCount === "number" &&
        pageCount > 0 &&
        typeof imagePath === "string" &&
        imagePath.length > 0
      ) {
        const extension = isHasSVG ? "svg" : "png";
        const staticImageUrls = Array.from({ length: pageCount }, (_, index) => {
          const pageUrl = `${imagePath}score_${index}.${extension}`;
          return typeof revised === "number"
            ? `${pageUrl}?no-cache=${revised}`
            : pageUrl;
        });

        if (
          typeof scoreId === "number" &&
          typeof releaseVer === "string" &&
          releaseVer.length > 0 &&
          typeof unifiedId === "string" &&
          unifiedId.length > 0 &&
          pageCount > 1
        ) {
          const resolvedImageUrls = [staticImageUrls[0]];

          for (let index = 1; index < staticImageUrls.length; index++) {
            resolvedImageUrls.push(
              await resolveSecureImageUrl(scoreId, index, releaseVer, unifiedId)
            );
          }

          return {
            imageUrls: resolvedImageUrls,
            isHasSVG,
            releaseVer,
            scoreId,
            unifiedId,
          };
        }

        return {
          imageUrls: staticImageUrls,
          isHasSVG,
          releaseVer,
          scoreId,
          unifiedId,
        };
      }
      console.log("[download] embedded store missing image data");
    } catch (error) {
      console.error("[download] embedded store parse failed", error);
    }
  }

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
  const dedupedUrls = urls.filter((u) => {
    if (seen.has(u)) return false;
    seen.add(u);
    return true;
  });

  console.log("[download] fallback extraction", {
    titleImageCount: $('img[title$="music notes"]').length,
    allImageCount: $("img[src]").length,
    extractedCount: dedupedUrls.length,
    sampleUrls: dedupedUrls.slice(0, 3),
  });

  return {
    imageUrls: dedupedUrls,
  };
}

/** Download an image and return its bytes. */
async function downloadImage(url: string): Promise<Uint8Array> {
  const res = await requestWithRetry<Buffer>(
    url,
    {
      headers: {
        ...BROWSER_HEADERS,
        Referer: "https://musescore.com/",
      },
      encoding: null,
    },
    2,
    500
  );
  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new Error(`Failed to download image ${url}: HTTP ${res.statusCode}`);
  }

  const contentTypeHeader = res.headers?.["content-type"];
  const contentType = Array.isArray(contentTypeHeader)
    ? contentTypeHeader[0] ?? ""
    : contentTypeHeader ?? "";
  const bodyBuffer = Buffer.from(res.body);
  const isSvg =
    /image\/svg\+xml/i.test(contentType) ||
    bodyBuffer.subarray(0, 512).toString("utf8").includes("<svg");

  if (isSvg) {
    const pngBuffer = await sharp(bodyBuffer).png().toBuffer();
    return new Uint8Array(pngBuffer);
  }

  return new Uint8Array(bodyBuffer);
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
    const pageRes = await requestWithRetry<string>(
      url,
      { headers: BROWSER_HEADERS },
      2,
      1500
    );

    if (pageRes.statusCode < 200 || pageRes.statusCode >= 300) {
      if (pageRes.statusCode === 403 || pageRes.statusCode === 503) {
        res.status(502).json({
          error:
            "MuseScore returned a Cloudflare challenge page. The score could not be fetched at this time. Please try again in a few seconds.",
        });
        return;
      }
      res.status(502).json({
        error: `MuseScore returned HTTP ${pageRes.statusCode}. Please check the URL and try again.`,
      });
      return;
    }

    html = pageRes.body;
    console.log("[download] fetched MuseScore page", {
      url,
      statusCode: pageRes.statusCode,
      htmlLength: html.length,
    });
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
  const extraction = await extractScoreImageUrls(html);
  const imageUrls = extraction.imageUrls;
  console.log("[download] extracted image URLs", {
    count: imageUrls.length,
    sampleUrls: imageUrls.slice(0, 5),
    scoreId: extraction.scoreId,
  });

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
