/**
 * AUTHORIZATION AUDIT — CLI.
 *
 * The scan itself lives in ./authzAudit so it can be run by an automated test
 * on every change. This wrapper only prints it.
 */
import { auditAuthz } from "./authzAudit";

const r = auditAuthz();

console.log("=".repeat(72));
console.log("CONVEX AUTHORIZATION AUDIT");
console.log("=".repeat(72));
console.log(`public functions : ${r.publicCount}`);
console.log(`internal functions: ${r.internalCount}`);
console.log(`NO AUTH          : ${r.noAuth.length}`);
console.log(`NO OWNERSHIP     : ${r.noOwnership.length}`);
console.log(`reviewed public  : ${r.reviewedPublic.length}`);

if (r.reviewedPublic.length) {
  console.log("\n--- PUBLIC BY DESIGN (reviewed; metadata only, no keys, no user data) ---");
  for (const f of r.reviewedPublic) console.log(`  ${f.file} :: ${f.fn} (${f.kind})`);
}
if (r.noAuth.length) {
  console.log("\n--- NO AUTHENTICATION CHECK (highest risk) ---");
  for (const f of r.noAuth) console.log(`  ${f.file} :: ${f.fn} (${f.kind})`);
}
if (r.noOwnership.length) {
  console.log("\n--- AUTHENTICATED BUT NO OWNERSHIP MARKER (verify by hand) ---");
  for (const f of r.noOwnership) console.log(`  ${f.file} :: ${f.fn} (${f.kind})`);
}
console.log("=".repeat(72));

process.exit(r.noAuth.length > 0 ? 1 : 0);
