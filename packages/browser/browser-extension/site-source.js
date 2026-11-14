/** MAIN-world current-site observation. No network or UI actions are performed here. */
export function observeSiteSource(input) {
  const fail = (message) => ({
    ok: false,
    error: { code: "FILE_UNAVAILABLE", message },
  });
  try {
    const page = new URL(location.href);
    if (input.method === "content.exportGsuite") {
      if (page.hostname !== "docs.google.com")
        return fail(
          "The current document is not a supported Google Workspace editor.",
        );
      const match = page.pathname.match(
        /^\/(document|spreadsheets|presentation)\/(?:u\/\d+\/)?d\/([A-Za-z0-9_-]+)(?:\/|$)/,
      );
      if (!match)
        return fail(
          "The current Google Workspace document has no observable export identity.",
        );
      const [, kind, id] = match,
        allowed = {
          document: ["pdf", "docx", "md"],
          spreadsheets: ["pdf", "xlsx", "csv"],
          presentation: ["pdf", "pptx"],
        };
      if (!allowed[kind].includes(input.format))
        return fail("This document does not export the requested format.");
      const url = new URL(
        `/${kind}/d/${id}/export${kind === "presentation" ? `/${input.format}` : ""}`,
        page.origin,
      );
      if (kind !== "presentation") url.searchParams.set("format", input.format);
      if (kind === "spreadsheets" && input.format === "csv") {
        const gid =
          new URLSearchParams(page.hash.slice(1)).get("gid") ??
          page.searchParams.get("gid");
        if (gid && /^\d+$/.test(gid)) url.searchParams.set("gid", gid);
      }
      return {
        ok: true,
        value: {
          kind: "gsuite",
          url: url.href,
          title: document.title,
          pageUrl: page.href,
          format: input.format,
        },
      };
    }
    if (
      input.method !== "content.exportYouTubeTranscript" ||
      !/(^|\.)youtube\.com$/.test(page.hostname)
    )
      return fail(
        "The current page is not a supported YouTube video document.",
      );
    const videoId =
      page.searchParams.get("v") ??
      page.pathname.match(/^\/(?:shorts|live)\/([A-Za-z0-9_-]+)/)?.[1];
    if (!videoId || !/^[A-Za-z0-9_-]{6,64}$/.test(videoId))
      return fail("The current YouTube document has no video identity.");
    const segments = [
      ...document.querySelectorAll("ytd-transcript-segment-renderer"),
    ];
    if (segments.length) {
      if (segments.length > 20000)
        return fail("The rendered transcript exceeds its segment budget.");
      const transcript = segments
        .map((node) => {
          const stamp = node
              .querySelector(".segment-timestamp")
              ?.textContent?.trim(),
            body = node.querySelector(".segment-text")?.textContent?.trim();
          return body ? `${stamp ? `[${stamp}] ` : ""}${body}` : "";
        })
        .filter(Boolean)
        .join("\n");
      if (
        transcript &&
        new TextEncoder().encode(transcript).byteLength <= 1024 * 1024
      )
        return {
          ok: true,
          value: {
            kind: "transcript-dom",
            text: transcript,
            title: document.title,
            pageUrl: page.href,
            videoId,
          },
        };
    }
    const response =
      globalThis.ytInitialPlayerResponse ??
      document.querySelector("#movie_player")?.getPlayerResponse?.();
    if (
      response?.videoDetails?.videoId &&
      response.videoDetails.videoId !== videoId
    )
      return fail("The player response belongs to an earlier video.");
    const tracks =
      response?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    if (!Array.isArray(tracks) || !tracks.length || tracks.length > 64)
      return fail(
        "This video has no observable caption track or rendered transcript.",
      );
    const track = tracks.find(
      (value) =>
        typeof value.baseUrl === "string" && value.baseUrl.length <= 65536,
    );
    if (!track) return fail("The actual caption track has no readable URL.");
    const url = new URL(track.baseUrl);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      !/(^|\.)(?:youtube\.com|googlevideo\.com)$/.test(url.hostname)
    )
      return fail(
        "The observed caption URL is outside this site's supported source.",
      );
    return {
      ok: true,
      value: {
        kind: "transcript-track",
        url: url.href,
        title: response.videoDetails?.title ?? document.title,
        pageUrl: page.href,
        videoId,
      },
    };
  } catch {
    return fail(
      "The browser could not observe this site's actual content source.",
    );
  }
}
