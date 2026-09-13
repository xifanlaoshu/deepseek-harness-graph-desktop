# Agent Note: Retire MCP connection generations after tool request deadlines

Status: implemented

English | [中文](2026-08-26-mcp-timeout-generation-retirement.zh.md)

## Problem

An MCP server process can remain alive while one tool request never settles. The SDK deadline rejects only the caller's Promise; it does not close the transport. A supervisor that treats process closure as the sole loss signal continues routing later calls to the same unavailable generation, so each retry consumes another complete deadline and an agent can remain in a repeated timeout loop.

## Decision

The MCP bridge recognizes only the SDK `RequestTimeout` error as a tool-request deadline. The first deadline quarantines its exact client generation before the error reaches the model. New calls through definitions owned by that generation fail immediately with `MCP_CONNECTION_UNAVAILABLE`; concurrent deadlines can report their own uncertain outcomes but cannot start another retirement.

The connection supervisor closes the quarantined client and waits for the transport-owned close signal before scheduling its existing bounded reconnect policy. A replacement client performs complete tool discovery and atomically replaces the old definitions. Failure to observe closure within the existing generation-close deadline stops reconnection rather than allowing overlapping server processes. Plugin disposal waits for deadline-driven retirement as well as connection and synchronization work.

The original call returns `MCP_REQUEST_TIMEOUT` and states that its remote outcome is unknown. The bridge never replays it automatically because an MCP tool may have completed its side effect before its response stalled. Caller cancellation, server-declared tool errors, and other request failures do not quarantine a healthy generation.

## Alternatives considered

**Let the model retry against the same client.** Rejected because the live process is not evidence that its request path remains usable, and every retry can consume the full deadline without creating a recovery event.

**Retry the timed-out tool automatically after reconnect.** Rejected because the timeout leaves execution uncertain; replay can duplicate writes, submissions, or destructive operations.

**Start a replacement before the old transport closes.** Rejected because stdio server ownership includes its child process and resources. Overlapping generations can control the same external system or leave orphan processes.

**Retire on every MCP error.** Rejected because validation, authorization, and tool-declared failures are ordinary per-call outcomes and do not establish an unavailable connection.

## Verification

Supervisor tests cover deadline classification, immediate outage rejection, one retirement across concurrent timeouts, cancellation exclusion, post-reconnect execution, and the existing close barrier. A keyless real stdio MCP test runs a tool whose response never settles, snapshots the stable timeout diagnostic, and proves that a newly spawned generation serves the next call.

## Consequences

A wedged MCP generation consumes one configured tool deadline instead of one deadline per retry, and the existing reconnect budget governs recovery without another policy surface. Tool registrations remain stable during ordinary recovery, but calls fail fast until replacement discovery commits. Managed MCP servers may close resources they own during retirement; deployments that must preserve an external browser or service across MCP replacement keep that resource under a separate lifecycle and attach through a transport endpoint.
