// lib/linkedin.js — shared LinkedIn API constants for the 10-linkedin agents.

// LinkedIn's versioned /rest/ API requires a `LinkedIn-Version` header on every call, in
// YYYYMM format. LinkedIn sunsets versions ~1 year after release, so this MUST be bumped
// periodically (a stale value returns 426 NONEXISTENT_VERSION). One constant, one place to update.
export const LINKEDIN_API_VERSION = "202606";
