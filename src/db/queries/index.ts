// Re-export all domain modules for the compatibility facade.
// During migration, consumers still import from "../db/queries.js".

export * from "./entries.js";
export * from "./weights.js";
export * from "./chat.js";
export * from "./patterns.js";
export * from "./observability.js";
export * from "./oura.js";
export * from "./artifacts.js";
export * from "./todos.js";
export * from "./media.js";
export * from "./templates.js";
export * from "./content-search.js";
