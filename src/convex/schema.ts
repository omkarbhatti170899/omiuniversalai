import { authTables } from "@convex-dev/auth/server";
import { defineSchema, defineTable } from "convex/server";
import { Infer, v } from "convex/values";

// default user roles. can add / remove based on the project as needed
export const ROLES = {
  ADMIN: "admin",
  USER: "user",
  MEMBER: "member",
} as const;

export const roleValidator = v.union(
  v.literal(ROLES.ADMIN),
  v.literal(ROLES.USER),
  v.literal(ROLES.MEMBER),
);
export type Role = Infer<typeof roleValidator>;

const schema = defineSchema(
  {
    // default auth tables using convex auth.
    ...authTables, // do not remove or modify

    // the users table is the default users table that is brought in by the authTables
    users: defineTable({
      name: v.optional(v.string()), // name of the user. do not remove
      image: v.optional(v.string()), // image of the user. do not remove
      email: v.optional(v.string()), // email of the user. do not remove
      emailVerificationTime: v.optional(v.number()), // email verification time. do not remove
      isAnonymous: v.optional(v.boolean()), // is the user anonymous. do not remove

      role: v.optional(roleValidator), // role of the user. do not remove
    }).index("email", ["email"]), // index for the email. do not remove or modify

    // Human Emotions AI — one analysis record per run, scoped to the signed-in user
    emotionAnalyses: defineTable({
      userId: v.id("users"),
      text: v.string(),
      emotion: v.string(),
      confidence: v.number(), // 0..1
      rantScore: v.optional(v.number()),
      rantInterpretation: v.optional(v.string()),
      sentiment: v.optional(v.string()),
      sentimentScore: v.optional(v.number()),
      urgency: v.optional(v.string()),
      urgencyScore: v.optional(v.number()),
      signalFields: v.optional(v.string()),
      advice: v.optional(v.string()),
      omiNote: v.optional(v.string()),
    }).index("by_user", ["userId"]),

    // Omi Search — saved web searches with Omi's cited answer
    webSearches: defineTable({
      userId: v.id("users"),
      query: v.string(),
      answer: v.string(),
      citations: v.array(
        v.object({
          title: v.string(),
          url: v.string(),
          snippet: v.optional(v.string()),
        }),
      ),
    }).index("by_user", ["userId"]),

    // add other tables here

    // tableName: defineTable({
    //   ...
    //   // table fields
    // }).index("by_field", ["field"])
  },
  {
    schemaValidation: false,
  },
);

export default schema;
