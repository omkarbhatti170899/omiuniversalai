/**
 * Image intent layer + prompt normalizer (pure, zero network).
 *
 * These two modules ARE the answer to the production bug this engine was
 * rebuilt for: an edit request was answered by a text-to-image provider, so
 * "put me in Paris" came back as a brand-new random scene. Nothing downstream
 * can fix that if the classification is wrong, so the classification and the
 * preservation clause are pinned here:
 *
 *  • generate vs edit vs understanding, and the chat false-positive guard
 *    ("generate a report" must never reach the paint engine);
 *  • the STUDIO vs CHAT difference — inside Image Studio a bare description is
 *    a generation request, in Chat it is not;
 *  • preservation: an edit states exactly what must NOT change, and targeting
 *    the background is decided by the user's words, not by the op alone.
 */
import { describe, test, expect } from "bun:test";
import {
  classifyImageIntent,
  editOpFor,
  extractReferences,
  resolveReferenceIndices,
} from "../src/convex/aiProviders/imageIntent";
import {
  normalizeImageRequest,
  preserveDefaults,
  targetsBackground,
} from "../src/convex/aiProviders/imageNormalize";

const CHAT = "chat" as const;
const STUDIO = "studio" as const;

describe("intent — generation", () => {
  test("a verb plus an image noun generates in chat", () => {
    const intent = classifyImageIntent("generate a logo for a coffee brand", false, 0, CHAT);
    expect(intent.kind).toBe("generate");
  });

  test("a bare description generates in the Studio but NOT in chat", () => {
    // The Studio's own placeholder text. Chat must stay conservative (nothing
    // in it asks for a picture); the Studio is already an image surface.
    const phrase = "create a cyberpunk Mumbai at night";
    expect(classifyImageIntent(phrase, false, 0, CHAT).kind).toBe("none");
    const studio = classifyImageIntent(phrase, false, 0, STUDIO);
    expect(studio.kind).toBe("generate");
  });

  test("a text-only ask is refused even inside the Studio", () => {
    // The document guard: Image Studio is not a place to answer "write me a
    // report" with a picture.
    expect(classifyImageIntent("write me a report about EVs", false, 0, STUDIO).kind).toBe("none");
  });

  test("aspect ratio and transparency are read from the user's words", () => {
    const intent = classifyImageIntent(
      "create a transparent square logo",
      false,
      0,
      CHAT,
    );
    if (intent.kind !== "generate") throw new Error("expected generate");
    expect(intent.aspectRatio).toBe("1:1");
    expect(intent.transparent).toBe(true);
  });

  test("chat questions about facts do not become image requests", () => {
    for (const turn of [
      "generate a report on electric vehicle charging standards",
      "draw conclusions from this dataset",
      "can you summarise this thread for me",
    ]) {
      expect(classifyImageIntent(turn, false, 0, CHAT).kind).toBe("none");
    }
  });
});

describe("intent — editing", () => {
  const edit = (text: string) => {
    const intent = classifyImageIntent(text, true, 1, CHAT);
    if (intent.kind !== "image-edit") throw new Error(`expected image-edit for "${text}"`);
    return intent;
  };

  test("classifies the natural examples from the master plan", () => {
    expect(edit("Remove the background from this photo").op).toBe("remove");
    expect(edit("Make this image more cinematic").op).toBe("style");
    expect(edit("Make it brighter").op).toBe("edit");
    expect(edit("Create another version of this").op).toBe("variation");
    expect(edit("Upscale this to a higher resolution").op).toBe("upscale");
    expect(edit("Enhance the details in this image").op).toBe("enhance");
    expect(edit("Combine these two images").op).toBe("combine");
    expect(edit("Put me in Tokyo").op).toBe("edit");
  });

  test("combine requires two images", () => {
    const intent = edit("combine these two photos into one");
    expect(intent.op).toBe("combine");
    expect(intent.needsMultiple).toBe(true);
  });

  test("an edit that refers to an image asks for it instead of running", () => {
    for (const text of [
      "remove the background from this photo", // anaphora
      "remove the background from my logo", // image noun
    ]) {
      const intent = classifyImageIntent(text, false, 0, CHAT);
      if (intent.kind !== "image-edit") throw new Error(`expected image-edit for "${text}"`);
      expect(intent.needsImage).toBe(true);
      expect(intent.op).toBe("remove");
    }
  });

  test("an edit with no context image is never answered with a generated one", () => {
    // The Studio must ask for the image — the alternative is the bug this
    // engine was rebuilt for: an edit answered by a fresh random image.
    const studio = classifyImageIntent("remove the background", false, 0, STUDIO);
    if (studio.kind !== "image-edit") throw new Error("expected image-edit");
    expect(studio.needsImage).toBe(true);
    expect(studio.op).toBe("remove");
  });

  test("a bare `replace` verb is a subject edit, not background replacement", () => {
    // Returning `replace` here made the normalizer tell the model to preserve
    // the very background it had been asked to change.
    expect(editOpFor("replace the shirt with a jacket")).toBe("edit");
    expect(editOpFor("replace the background with a beach")).toBe("replace");
  });
});

describe("intent — understanding is not editing", () => {
  test("questions ABOUT an image go to vision", () => {
    const intent = classifyImageIntent("what's in this picture?", true, 1, CHAT);
    expect(intent.kind).toBe("image-understanding");
  });

  test("an edit verb still wins over the question form", () => {
    const intent = classifyImageIntent("what should I change?", true, 1, CHAT);
    expect(intent.kind).toBe("image-edit");
  });

  test("empty input is never an image request", () => {
    expect(classifyImageIntent("   ", true, 1, CHAT).kind).toBe("none");
    expect(classifyImageIntent("", false, 0, STUDIO).kind).toBe("none");
  });
});

describe("intent — references", () => {
  test("resolves 'these two' to every image in context", () => {
    expect(resolveReferenceIndices(extractReferences("combine these two"), 2)).toEqual([0, 1]);
  });

  test("resolves 'the last image' to the newest one", () => {
    expect(resolveReferenceIndices(extractReferences("edit the last image"), 3)).toEqual([2]);
  });

  test("out-of-range and unknown references degrade to the first image", () => {
    expect(resolveReferenceIndices([{ kind: "ordinal", index: 7 }], 2)).toEqual([0]);
    expect(resolveReferenceIndices([], 0)).toEqual([]);
  });
});

describe("normalizer — preservation is the difference between edit and redraw", () => {
  test("an edit prompt states the change AND what must not move", () => {
    const req = normalizeImageRequest("edit", "Change the shirt to black.");
    expect(req.preservation).toBe(true);
    expect(req.prompt).toContain("Requested change: Change the shirt to black.");
    expect(req.prompt).toContain("Preserve exactly");
    expect(req.prompt).toContain("Make ONLY the requested change");
    const preserve = req.preserve.join(" | ").toLowerCase();
    expect(preserve).toContain("identity");
    expect(preserve).toContain("pose");
    expect(preserve).toContain("lighting");
    expect(preserve).toContain("the background");
  });

  test("generation keeps the user's own wording and adds no preservation clause", () => {
    const req = normalizeImageRequest("generate", "a lone observatory on a graphite ridge");
    expect(req.preservation).toBe(false);
    expect(req.preserve).toEqual([]);
    expect(req.prompt.startsWith("a lone observatory on a graphite ridge")).toBe(true);
    expect(req.prompt).not.toContain("Preserve exactly");
  });

  test("background is preserved unless the request targets it", () => {
    expect(targetsBackground("remove", "remove the background")).toBe(true);
    expect(targetsBackground("remove", "remove the person on the left")).toBe(false);
    expect(targetsBackground("replace", "put me on a beach")).toBe(true);
    // A placement edit changes the setting without naming the background.
    expect(targetsBackground("edit", "put me in Paris at night")).toBe(true);
    expect(targetsBackground("edit", "make the shirt black")).toBe(false);
  });

  test("structural ops narrow the preservation list", () => {
    const upscale = preserveDefaults("upscale").join(" | ").toLowerCase();
    expect(upscale).toContain("only clarity/resolution improves");
    // Nothing is preserved for a pure generation.
    expect(preserveDefaults("generate")).toEqual([]);
  });

  test("subject/environment/style/lighting are extracted, not invented", () => {
    const req = normalizeImageRequest("edit", "Make this image a cinematic night shot in Tokyo");
    // Extracted verbatim — the normalizer never rewrites the user's own words.
    expect(req.environment).toBe("Tokyo");
    expect(req.style).toBe("cinematic");
    expect(req.lighting).toBe("night");
    const plain = normalizeImageRequest("edit", "Change the shirt to black");
    expect(plain.environment).toBe("");
    expect(plain.style).toBe("");
  });
});
