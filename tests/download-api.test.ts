import { describe, expect, it } from "vitest";
import { isCloudflareChallengePage } from "../pages/api/download";

describe("isCloudflareChallengePage", () => {
  it("detects challenge marker tokens", () => {
    expect(
      isCloudflareChallengePage(
        "<html><body><script>window._cf_chl_opt={};</script></body></html>"
      )
    ).toBe(true);
  });

  it("detects browser check challenge pages", () => {
    expect(
      isCloudflareChallengePage(
        "<html><title>Just a moment...</title><body>Checking your browser before accessing musescore.com.</body></html>"
      )
    ).toBe(true);
  });

  it("does not flag normal score page html", () => {
    expect(
      isCloudflareChallengePage(
        '<html><body><img title="music notes" src="https://musescore.com/score_1.png"></body></html>'
      )
    ).toBe(false);
  });
});
