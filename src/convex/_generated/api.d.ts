/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as aiErrors from "../aiErrors.js";
import type * as aiProviders_catalog from "../aiProviders/catalog.js";
import type * as aiProviders_imageCatalog from "../aiProviders/imageCatalog.js";
import type * as aiProviders_imageIntent from "../aiProviders/imageIntent.js";
import type * as aiProviders_imageNormalize from "../aiProviders/imageNormalize.js";
import type * as aiProviders_imageProviders from "../aiProviders/imageProviders.js";
import type * as aiProviders_imageRouter from "../aiProviders/imageRouter.js";
import type * as aiProviders_imageVerify from "../aiProviders/imageVerify.js";
import type * as aiProviders_index from "../aiProviders/index.js";
import type * as aiProviders_modelDiscovery from "../aiProviders/modelDiscovery.js";
import type * as aiProviders_openaiCompat from "../aiProviders/openaiCompat.js";
import type * as aiProviders_vision from "../aiProviders/vision.js";
import type * as aiProviders_visionCatalog from "../aiProviders/visionCatalog.js";
import type * as aiProviders_vly from "../aiProviders/vly.js";
import type * as aiStatus from "../aiStatus.js";
import type * as andromeda_actions from "../andromeda/actions.js";
import type * as andromeda_corpus from "../andromeda/corpus.js";
import type * as andromeda_gates from "../andromeda/gates.js";
import type * as andromeda_insight from "../andromeda/insight.js";
import type * as andromeda_orchestrator from "../andromeda/orchestrator.js";
import type * as andromeda_query from "../andromeda/query.js";
import type * as auth from "../auth.js";
import type * as auth_emailOtp from "../auth/emailOtp.js";
import type * as deepResearch from "../deepResearch.js";
import type * as deepResearchRuns from "../deepResearchRuns.js";
import type * as ecosystem from "../ecosystem.js";
import type * as ecosystemStatus from "../ecosystemStatus.js";
import type * as emotions from "../emotions.js";
import type * as emotionsAi from "../emotionsAi.js";
import type * as emotionsEngine from "../emotionsEngine.js";
import type * as http from "../http.js";
import type * as knowledgeEngine_analytics from "../knowledgeEngine/analytics.js";
import type * as knowledgeEngine_critic from "../knowledgeEngine/critic.js";
import type * as knowledgeEngine_governance from "../knowledgeEngine/governance.js";
import type * as knowledgeEngine_grounding from "../knowledgeEngine/grounding.js";
import type * as knowledgeEngine_select from "../knowledgeEngine/select.js";
import type * as omiAgentRuntime from "../omiAgentRuntime.js";
import type * as omiAgents from "../omiAgents.js";
import type * as omiAudit from "../omiAudit.js";
import type * as omiChat from "../omiChat.js";
import type * as omiConversations from "../omiConversations.js";
import type * as omiFiles from "../omiFiles.js";
import type * as omiHealth from "../omiHealth.js";
import type * as omiIdentity from "../omiIdentity.js";
import type * as omiImages from "../omiImages.js";
import type * as omiImprove from "../omiImprove.js";
import type * as omiKnowledge from "../omiKnowledge.js";
import type * as omiKnowledgeIntelligence from "../omiKnowledgeIntelligence.js";
import type * as omiMemories from "../omiMemories.js";
import type * as omiMessages from "../omiMessages.js";
import type * as omiMultimodal from "../omiMultimodal.js";
import type * as omiProjects from "../omiProjects.js";
import type * as omiSelfTest from "../omiSelfTest.js";
import type * as omiSettings from "../omiSettings.js";
import type * as omiTasks from "../omiTasks.js";
import type * as omiToolRuns from "../omiToolRuns.js";
import type * as omiTools_executor from "../omiTools/executor.js";
import type * as omiTools_registry from "../omiTools/registry.js";
import type * as omiTools_specialties from "../omiTools/specialties.js";
import type * as omiWorkflowDecisions from "../omiWorkflowDecisions.js";
import type * as omiWorkflowQueries from "../omiWorkflowQueries.js";
import type * as omiWorkflowStore from "../omiWorkflowStore.js";
import type * as omiWorkflows from "../omiWorkflows.js";
import type * as search from "../search.js";
import type * as searchCache from "../searchCache.js";
import type * as searchEngine_calculator from "../searchEngine/calculator.js";
import type * as searchEngine_decision from "../searchEngine/decision.js";
import type * as searchEngine_evidence from "../searchEngine/evidence.js";
import type * as searchEngine_quality from "../searchEngine/quality.js";
import type * as searchEngine_resilience from "../searchEngine/resilience.js";
import type * as searchEngine_retrieval from "../searchEngine/retrieval.js";
import type * as searchEngine_security from "../searchEngine/security.js";
import type * as searchHistory from "../searchHistory.js";
import type * as searchProviders_arxiv from "../searchProviders/arxiv.js";
import type * as searchProviders_commoncrawl from "../searchProviders/commoncrawl.js";
import type * as searchProviders_gdelt from "../searchProviders/gdelt.js";
import type * as searchProviders_github from "../searchProviders/github.js";
import type * as searchProviders_hackernews from "../searchProviders/hackernews.js";
import type * as searchProviders_index from "../searchProviders/index.js";
import type * as searchProviders_keyless from "../searchProviders/keyless.js";
import type * as searchProviders_openalex from "../searchProviders/openalex.js";
import type * as searchProviders_openlibrary from "../searchProviders/openlibrary.js";
import type * as searchProviders_openmeteo from "../searchProviders/openmeteo.js";
import type * as searchProviders_openverse from "../searchProviders/openverse.js";
import type * as searchProviders_pageFetcher from "../searchProviders/pageFetcher.js";
import type * as searchProviders_searxng from "../searchProviders/searxng.js";
import type * as searchProviders_types from "../searchProviders/types.js";
import type * as searchProviders_wikidata from "../searchProviders/wikidata.js";
import type * as searchProviders_wikipedia from "../searchProviders/wikipedia.js";
import type * as searchStatus from "../searchStatus.js";
import type * as searchTelemetry from "../searchTelemetry.js";
import type * as universalSearch from "../universalSearch.js";
import type * as users from "../users.js";
import type * as verification from "../verification.js";
import type * as workflows_approval from "../workflows/approval.js";
import type * as workflows_plan from "../workflows/plan.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  aiErrors: typeof aiErrors;
  "aiProviders/catalog": typeof aiProviders_catalog;
  "aiProviders/imageCatalog": typeof aiProviders_imageCatalog;
  "aiProviders/imageIntent": typeof aiProviders_imageIntent;
  "aiProviders/imageNormalize": typeof aiProviders_imageNormalize;
  "aiProviders/imageProviders": typeof aiProviders_imageProviders;
  "aiProviders/imageRouter": typeof aiProviders_imageRouter;
  "aiProviders/imageVerify": typeof aiProviders_imageVerify;
  "aiProviders/index": typeof aiProviders_index;
  "aiProviders/modelDiscovery": typeof aiProviders_modelDiscovery;
  "aiProviders/openaiCompat": typeof aiProviders_openaiCompat;
  "aiProviders/vision": typeof aiProviders_vision;
  "aiProviders/visionCatalog": typeof aiProviders_visionCatalog;
  "aiProviders/vly": typeof aiProviders_vly;
  aiStatus: typeof aiStatus;
  "andromeda/actions": typeof andromeda_actions;
  "andromeda/corpus": typeof andromeda_corpus;
  "andromeda/gates": typeof andromeda_gates;
  "andromeda/insight": typeof andromeda_insight;
  "andromeda/orchestrator": typeof andromeda_orchestrator;
  "andromeda/query": typeof andromeda_query;
  auth: typeof auth;
  "auth/emailOtp": typeof auth_emailOtp;
  deepResearch: typeof deepResearch;
  deepResearchRuns: typeof deepResearchRuns;
  ecosystem: typeof ecosystem;
  ecosystemStatus: typeof ecosystemStatus;
  emotions: typeof emotions;
  emotionsAi: typeof emotionsAi;
  emotionsEngine: typeof emotionsEngine;
  http: typeof http;
  "knowledgeEngine/analytics": typeof knowledgeEngine_analytics;
  "knowledgeEngine/critic": typeof knowledgeEngine_critic;
  "knowledgeEngine/governance": typeof knowledgeEngine_governance;
  "knowledgeEngine/grounding": typeof knowledgeEngine_grounding;
  "knowledgeEngine/select": typeof knowledgeEngine_select;
  omiAgentRuntime: typeof omiAgentRuntime;
  omiAgents: typeof omiAgents;
  omiAudit: typeof omiAudit;
  omiChat: typeof omiChat;
  omiConversations: typeof omiConversations;
  omiFiles: typeof omiFiles;
  omiHealth: typeof omiHealth;
  omiIdentity: typeof omiIdentity;
  omiImages: typeof omiImages;
  omiImprove: typeof omiImprove;
  omiKnowledge: typeof omiKnowledge;
  omiKnowledgeIntelligence: typeof omiKnowledgeIntelligence;
  omiMemories: typeof omiMemories;
  omiMessages: typeof omiMessages;
  omiMultimodal: typeof omiMultimodal;
  omiProjects: typeof omiProjects;
  omiSelfTest: typeof omiSelfTest;
  omiSettings: typeof omiSettings;
  omiTasks: typeof omiTasks;
  omiToolRuns: typeof omiToolRuns;
  "omiTools/executor": typeof omiTools_executor;
  "omiTools/registry": typeof omiTools_registry;
  "omiTools/specialties": typeof omiTools_specialties;
  omiWorkflowDecisions: typeof omiWorkflowDecisions;
  omiWorkflowQueries: typeof omiWorkflowQueries;
  omiWorkflowStore: typeof omiWorkflowStore;
  omiWorkflows: typeof omiWorkflows;
  search: typeof search;
  searchCache: typeof searchCache;
  "searchEngine/calculator": typeof searchEngine_calculator;
  "searchEngine/decision": typeof searchEngine_decision;
  "searchEngine/evidence": typeof searchEngine_evidence;
  "searchEngine/quality": typeof searchEngine_quality;
  "searchEngine/resilience": typeof searchEngine_resilience;
  "searchEngine/retrieval": typeof searchEngine_retrieval;
  "searchEngine/security": typeof searchEngine_security;
  searchHistory: typeof searchHistory;
  "searchProviders/arxiv": typeof searchProviders_arxiv;
  "searchProviders/commoncrawl": typeof searchProviders_commoncrawl;
  "searchProviders/gdelt": typeof searchProviders_gdelt;
  "searchProviders/github": typeof searchProviders_github;
  "searchProviders/hackernews": typeof searchProviders_hackernews;
  "searchProviders/index": typeof searchProviders_index;
  "searchProviders/keyless": typeof searchProviders_keyless;
  "searchProviders/openalex": typeof searchProviders_openalex;
  "searchProviders/openlibrary": typeof searchProviders_openlibrary;
  "searchProviders/openmeteo": typeof searchProviders_openmeteo;
  "searchProviders/openverse": typeof searchProviders_openverse;
  "searchProviders/pageFetcher": typeof searchProviders_pageFetcher;
  "searchProviders/searxng": typeof searchProviders_searxng;
  "searchProviders/types": typeof searchProviders_types;
  "searchProviders/wikidata": typeof searchProviders_wikidata;
  "searchProviders/wikipedia": typeof searchProviders_wikipedia;
  searchStatus: typeof searchStatus;
  searchTelemetry: typeof searchTelemetry;
  universalSearch: typeof universalSearch;
  users: typeof users;
  verification: typeof verification;
  "workflows/approval": typeof workflows_approval;
  "workflows/plan": typeof workflows_plan;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
