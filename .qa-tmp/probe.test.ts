import { test } from "bun:test";
import { freshnessPolicyFor } from "../src/convex/searchEngine/freshness";
import { classifyCurrentIntent } from "../src/convex/searchEngine/intent";
for (const v of ["news","sports","markets","election","travel","general"]) {
  const q = `latest ${v} update right now`;
  const p = freshnessPolicyFor(q, classifyCurrentIntent(q));
  console.log(v, "->", p.vertical, JSON.stringify(p.preferredProviders));
}
