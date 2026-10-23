//! V2: GPU job requests, own-job listing/details, bounded logs and confirmed cancellation.
//! Every remote operation is a fixed script over the V1 ControlMaster; mutations are limited to
//! one `sbatch` per reviewed preview and one `scancel <id>` per confirmed request.

pub mod commands;
pub mod parse;
pub mod remote;
pub mod request;
pub mod store;

#[cfg(test)]
mod tests;
