/**
 * walkthrough.config.mjs — everything project-specific lives here.
 *
 * The scripts in this plugin are generic; this file is the only place that
 * knows your app's URL, selectors and scenes. Nothing secret belongs in here —
 * credentials and API keys come from .env (see .env.example).
 *
 * Copy to your project root as `walkthrough.config.mjs` and edit.
 */

export default {
  // ── the app under test ────────────────────────────────────────────────────
  // Read from env so the same config works against staging/prod. Never hardcode
  // a URL you might publish, and never reuse another project's env var name —
  // a recorder that silently falls back to the wrong APP_URL records the wrong
  // product, and it is surprisingly easy not to notice for a whole take.
  app: process.env.APP_URL || "https://example.test",

  // Accent colour for the cursor ring and annotation callouts, "r,g,b".
  // Sample it from the app's own stylesheet rather than guessing.
  accent: "255,107,26",

  // Capture size. Must match your display exactly when capture.mode === "dda".
  width: 1920,
  height: 1080,

  // ── auth ──────────────────────────────────────────────────────────────────
  // Sessions are stored in .auth/profile via `record.mjs --login`.
  // Credentials are optional: with them the recorder can re-authenticate itself
  // mid-run, which matters because a long take can outlive a short session.
  // Without them, --login opens a window and waits for you.
  login: {
    // A URL matching this regex means "not signed in".
    urlPattern: "/\\/(account|auth)\\/(login|register)/",
    // A selector that only exists on the signed-in shell.
    shell: 'header a[href="/"], nav',
    // Form fields, for optional automatic sign-in.
    user: "#login-input-user-name-or-email-address",
    pass: "#login-input-password",
    remember: "#login-input-remember-me",
    submit: 'button[type="submit"]',
    // env var NAMES, not values
    userEnv: "APP_EMAIL",
    passEnv: "APP_PASSWORD",
  },

  // ── capture ───────────────────────────────────────────────────────────────
  capture: {
    // "dda"  — kiosk browser + ffmpeg Desktop Duplication (Windows). Required
    //          for anything with continuous motion: WebGL, canvas, video,
    //          animation. Runs headed and takes over the screen.
    // "cdp"  — Playwright recordVideo. Fine for static DOM. Cannot carry 1080p
    //          motion; see SKILL.md for the measurements.
    mode: process.env.CAPTURE || "dda",
    fps: Number(process.env.CAP_FPS || 30),
    // Extra Chromium args. The GPU flags in record.mjs are always applied.
    args: [],
  },

  // ── modules ───────────────────────────────────────────────────────────────
  // One entry per video. `route` is where the take starts; `ready` is how the
  // recorder knows the page has actually rendered (the app may have no <h1>).
  modules: {
    tour: {
      route: "/",
      ready: "main",
      settle: 2000,

      // Optional: load a heavy page once BEFORE the clock starts, so its first
      // appearance in the take is instant. Anything that takes seconds to draw
      // (large asset, 3D model, big query) belongs here.
      prewarm: [],
      prewarmReady: null,

      // Chapter titles for chapters.mjs / verify-sync.mjs output.
      titles: {
        s01_intro: "Introduction",
      },

      scenes: [
        {
          id: "s01_intro",                 // must match the VO script's scene id
          // goto / gotoWait / ready run BEFORE the scene clock starts, so any
          // load time here is free. A wait placed at the START of a scene's
          // steps is NOT free — it plays under that scene's narration.
          goto: null,
          gotoWait: 1800,
          steps: [
            // cueIdx indexes the scene's SENTENCES. Run check-cues.mjs after
            // every VO regeneration: the aligner sometimes emits fewer cues
            // than there are sentences, and an out-of-range cueIdx silently
            // falls back to a flat guess.
            { do: "note", sel: "h1", label: "start here", cueIdx: 0 },
          ],
        },
      ],
    },
  },
};
