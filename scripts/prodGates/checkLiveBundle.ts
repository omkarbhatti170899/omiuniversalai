/**
 * GATE — the LIVE bundle must be compiled against the approved backend.
 * =============================================================================
 *
 * Deployment success is not proof. This fetches the actually-published bytes
 * from the Pages origin, resolves the entry chunks referenced by the live
 * `index.html`, and asserts that exactly one Convex deployment appears among
 * them — the approved one.
 *
 * This is the check that distinguishes "the workflow said success" from "the
 * site users load talks to production". It is also what detects a stale
 * publication: an older bundle still naming the retired deployment fails here.
 *
 * Usage: bun scripts/prodGates/checkLiveBundle.ts <baseUrl> <approvedBackend>
 *        (baseUrl must end with "/")
 */

import { approvedSlugOf, findConvexSlugs } from "./convexSlugs";

async function getText(url: string): Promise<string | null> {
  try {
    const response = await fetch(url, { redirect: "follow" });
    if (!response.ok) return null;
    return await response.text();
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const [baseUrl, approvedBackend] = process.argv.slice(2);

  if (!baseUrl || !approvedBackend) {
    console.error("usage: checkLiveBundle.ts <baseUrl> <approvedBackend>");
    process.exit(2);
  }

  const approvedSlug = approvedSlugOf(approvedBackend);
  if (!approvedSlug) {
    console.error(
      `::error::could not derive a Convex deployment slug from ${JSON.stringify(approvedBackend)}`,
    );
    process.exit(2);
  }

  const html = await getText(baseUrl);
  if (html === null) {
    console.error(`::error::could not fetch the live index at ${baseUrl}`);
    process.exit(1);
  }

  const assets = [
    ...new Set(html.match(/assets\/[A-Za-z0-9_.-]+\.js/g) ?? []),
  ].sort();
  if (assets.length === 0) {
    console.error("::error::no JS assets referenced by the live index.html");
    process.exit(1);
  }

  const foundSlugs = new Set<string>();
  let approvedSeen = false;

  for (const asset of assets) {
    const body = await getText(baseUrl + asset);
    if (body === null) {
      console.error(`::error::could not fetch live asset ${asset}`);
      process.exit(1);
    }
    const stripped = body;
    if (stripped.indexOf(approvedBackend) !== -1) approvedSeen = true;
    // findConvexSlugs strips the vendor example internally, so `approvedSeen`
    // above is the only place that needs the raw text.
    for (const slug of findConvexSlugs(stripped)) foundSlugs.add(slug);
  }

  console.log("live assets:", assets.join(", "));
  console.log(
    "convex deployments in live bundle:",
    foundSlugs.size > 0 ? [...foundSlugs].sort().join(", ") : "(none)",
  );

  const problems: string[] = [];
  if (!approvedSeen) {
    problems.push(
      `approved backend ${approvedBackend} is not present in the live bundle`,
    );
  }
  const strays = [...foundSlugs].filter((slug) => slug !== approvedSlug).sort();
  if (strays.length > 0) {
    problems.push(
      `non-production Convex deployment(s) in the live bundle: ${strays.join(", ")}`,
    );
  }

  if (problems.length > 0) {
    for (const problem of problems) console.error(`::error::${problem}`);
    process.exit(1);
  }

  console.log(`ok live bundle is compiled against '${approvedSlug}' only`);
}

void main();
