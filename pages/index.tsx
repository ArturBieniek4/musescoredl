import Head from "next/head";
import { useState, FormEvent } from "react";

type Status = "idle" | "loading" | "success" | "error";

export default function Home() {
  const [url, setUrl] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [message, setMessage] = useState("");
  const [pageCount, setPageCount] = useState<number | null>(null);

  const isValidMuseScoreUrl = (value: string) => {
    return /^https?:\/\/(www\.)?musescore\.com\//.test(value);
  };

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmed = url.trim();
    if (!trimmed) return;
    if (!isValidMuseScoreUrl(trimmed)) {
      setStatus("error");
      setMessage("Please enter a valid MuseScore URL (e.g. https://musescore.com/user/.../scores/...)");
      return;
    }

    setStatus("loading");
    setMessage("");
    setPageCount(null);

    try {
      const res = await fetch(`/api/download?url=${encodeURIComponent(trimmed)}`);

      if (!res.ok) {
        let errMsg = "Failed to download score.";
        try {
          const data = await res.json();
          if (data?.error) errMsg = data.error;
        } catch {
          // ignore JSON parse error
        }
        setStatus("error");
        setMessage(errMsg);
        return;
      }

      const countHeader = res.headers.get("X-Page-Count");
      if (countHeader) setPageCount(parseInt(countHeader, 10));

      const blob = await res.blob();
      const objectUrl = URL.createObjectURL(blob);

      // Use filename from Content-Disposition if provided
      const disposition = res.headers.get("Content-Disposition") ?? "";
      const nameMatch = disposition.match(/filename="([^"]+)"/);
      const downloadName = nameMatch ? nameMatch[1] : "score.pdf";

      const a = document.createElement("a");
      a.href = objectUrl;
      a.download = downloadName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(objectUrl);

      setStatus("success");
      setMessage("Your PDF is downloading!");
    } catch {
      setStatus("error");
      setMessage("An unexpected error occurred. Please try again.");
    }
  }

  return (
    <>
      <Head>
        <title>MuseScore Downloader – Free Sheet Music PDF</title>
        <meta
          name="description"
          content="Download MuseScore sheet music as a PDF for free. Paste any MuseScore URL to get started."
        />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="icon" href="/favicon.ico" />
      </Head>

      <main style={styles.main}>
        <div style={styles.card}>
          {/* Header */}
          <div style={styles.header}>
            <div style={styles.logoWrap}>
              <svg width="40" height="40" viewBox="0 0 40 40" fill="none" aria-hidden="true">
                <rect width="40" height="40" rx="10" fill="#6366f1" />
                <path
                  d="M12 28V14l4-2v12l4-4v-8l4-2v16l-4 2V22l-4 4v4l-4 2z"
                  fill="white"
                />
              </svg>
            </div>
            <h1 style={styles.title}>MuseScore Downloader</h1>
            <p style={styles.subtitle}>
              Paste a MuseScore URL below to download the sheet music as a PDF.
            </p>
          </div>

          {/* Form */}
          <form onSubmit={handleSubmit} style={styles.form}>
            <label htmlFor="score-url" style={styles.label}>
              MuseScore URL
            </label>
            <div style={styles.inputRow}>
              <input
                id="score-url"
                type="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://musescore.com/user/12345/scores/6789"
                style={styles.input}
                disabled={status === "loading"}
                required
              />
              <button
                type="submit"
                style={{
                  ...styles.button,
                  ...(status === "loading" ? styles.buttonDisabled : {}),
                }}
                disabled={status === "loading"}
              >
                {status === "loading" ? (
                  <span style={styles.spinnerWrap}>
                    <span style={styles.spinner} />
                    Fetching…
                  </span>
                ) : (
                  "Download PDF"
                )}
              </button>
            </div>
          </form>

          {/* Status messages */}
          {status === "error" && (
            <div style={{ ...styles.alert, ...styles.alertError }}>
              <strong>Error:</strong> {message}
            </div>
          )}
          {status === "success" && (
            <div style={{ ...styles.alert, ...styles.alertSuccess }}>
              <strong>✓</strong>{" "}
              {message}
              {pageCount !== null && (
                <span> ({pageCount} page{pageCount !== 1 ? "s" : ""})</span>
              )}
            </div>
          )}

          {/* How it works */}
          <div style={styles.howItWorks}>
            <h2 style={styles.h2}>How it works</h2>
            <ol style={styles.ol}>
              <li>Paste any public MuseScore score URL above.</li>
              <li>The server fetches the score page and extracts the sheet music images.</li>
              <li>All pages are combined into a single PDF and downloaded to your device.</li>
            </ol>
          </div>

          <p style={styles.footer}>
            For personal use only. Respect copyright and MuseScore&apos;s{" "}
            <a
              href="https://musescore.com/legal/terms"
              target="_blank"
              rel="noreferrer"
            >
              Terms of Service
            </a>
            .
          </p>
        </div>
      </main>
    </>
  );
}

const styles: Record<string, React.CSSProperties> = {
  main: {
    minHeight: "100vh",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "24px 16px",
    background: "linear-gradient(135deg, #0f172a 0%, #1e293b 100%)",
  },
  card: {
    background: "#1e293b",
    borderRadius: "16px",
    padding: "40px 36px",
    width: "100%",
    maxWidth: "600px",
    boxShadow: "0 25px 50px rgba(0,0,0,0.5)",
    border: "1px solid #334155",
  },
  header: {
    textAlign: "center",
    marginBottom: "32px",
  },
  logoWrap: {
    marginBottom: "16px",
    display: "flex",
    justifyContent: "center",
  },
  title: {
    fontSize: "1.75rem",
    fontWeight: 700,
    color: "#f1f5f9",
    marginBottom: "8px",
  },
  subtitle: {
    color: "#94a3b8",
    fontSize: "1rem",
  },
  form: {
    marginBottom: "20px",
  },
  label: {
    display: "block",
    fontWeight: 600,
    marginBottom: "8px",
    color: "#cbd5e1",
    fontSize: "0.9rem",
  },
  inputRow: {
    display: "flex",
    gap: "10px",
    flexWrap: "wrap" as const,
  },
  input: {
    flex: "1 1 260px",
    padding: "12px 16px",
    borderRadius: "8px",
    border: "1.5px solid #475569",
    background: "#0f172a",
    color: "#f1f5f9",
    fontSize: "0.95rem",
    outline: "none",
    transition: "border-color 0.2s",
  },
  button: {
    padding: "12px 22px",
    borderRadius: "8px",
    border: "none",
    background: "#6366f1",
    color: "#fff",
    fontWeight: 600,
    fontSize: "0.95rem",
    cursor: "pointer",
    whiteSpace: "nowrap" as const,
    transition: "background 0.2s",
  },
  buttonDisabled: {
    background: "#4b5563",
    cursor: "not-allowed",
  },
  spinnerWrap: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
  },
  spinner: {
    display: "inline-block",
    width: "14px",
    height: "14px",
    border: "2px solid rgba(255,255,255,0.3)",
    borderTopColor: "#fff",
    borderRadius: "50%",
    animation: "spin 0.7s linear infinite",
  },
  alert: {
    borderRadius: "8px",
    padding: "12px 16px",
    marginBottom: "20px",
    fontSize: "0.9rem",
  },
  alertError: {
    background: "rgba(239,68,68,0.15)",
    border: "1px solid rgba(239,68,68,0.4)",
    color: "#fca5a5",
  },
  alertSuccess: {
    background: "rgba(34,197,94,0.12)",
    border: "1px solid rgba(34,197,94,0.4)",
    color: "#86efac",
  },
  howItWorks: {
    background: "#0f172a",
    borderRadius: "10px",
    padding: "20px",
    marginBottom: "20px",
  },
  h2: {
    fontSize: "1rem",
    fontWeight: 600,
    marginBottom: "10px",
    color: "#e2e8f0",
  },
  ol: {
    paddingLeft: "20px",
    color: "#94a3b8",
    fontSize: "0.9rem",
    lineHeight: "1.8",
  },
  footer: {
    textAlign: "center",
    color: "#64748b",
    fontSize: "0.8rem",
  },
};
