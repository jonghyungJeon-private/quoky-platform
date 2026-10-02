# Personal Work Surface

M3A-1 exposes one read-only answer to “Show me what I need to work on.” It is a rebuildable, non-authoritative
application projection under ADR-0074, not a work database or workflow.

## Contract

- `ResourceRef { source, externalId }` is the stable value identity of an external input. It is not an Aggregate,
  connector payload, cache record, or output Artifact.
- `WorkSurfaceQuery.forActor(actor)` resolves only explicit `Actor.identities` entries for `jira` and `github`.
  It never fabricates, infers, or auto-links an identity.
- Jira and GitHub are queried through read-only `ConnectorProvider` implementations using the semantic
  `personal-work` query. Connector protocol rendering remains inside each adapter.
- Items are normalized to `ResourceRef`-backed application DTOs and stably sorted by source, title, and external id.
- Each source reports `AVAILABLE`, `IDENTITY_MISSING`, `NOT_CONFIGURED`, or `UNAVAILABLE`. A one-source result is
  explicitly `PARTIAL`; an unavailable source can never be silently rendered as “you have no work.”

## Live Identity Reachability

M3A-1.1 adds an app-private startup provisioner. `QUOKY_ACTOR_IDENTITY_MAPPINGS` is an optional JSON array whose
entries have the exact shape below. It is parsed and validated before application, then applied after storage
initialization and before the platform starts.

```json
[{"actor":{"platform":"discord","externalId":"123456789"},"identities":{"jira":"jira-assignee-id","github":"octocat"}}]
```

The Discord locator must already resolve through `ActorRepository.findByExternalIdentity`; provisioning never
creates an Actor. Jira is a non-blank assignee identifier and is not assumed to be email. GitHub is a validated
login. The mapping is non-secret and must not contain credentials, tokens, App installation ids, repository owner,
or tenant data. Unknown fields fail validation.

Provisioning is additive and idempotent. An omitted Jira/GitHub key removes nothing. A mapping entry whose Discord
Actor does not exist yet is skipped with a warning (the bot never crashes startup and never creates the Actor; message
the bot once, then restart to apply it). A blank value, different identity for an already-linked platform, identity
owned by another Actor, or conflicting effective config fails closed. There is no replacement, unlink, merge,
discovery, or heuristic resolution. Connector configuration
and availability remain separate prerequisites, and an actual live read remains a separately authorized network
operation.

## Boundaries

The surface persists nothing and introduces no `WorkItem`, repository, table, migration, lifecycle, connector
write, MCP/tool seam, agent, handoff, trigger, scheduler, receipt, ledger, graph, Workflow, or event sourcing.
GitHub pull-request lifecycle and writes remain exclusively on `RepositoryHostingProvider`. Conversation Runtime
only recognizes the bounded intent, invokes `WorkSurfaceQuery`, and hands the result to `ResponseComposer`; it does
not parse configuration or participate in provisioning.
