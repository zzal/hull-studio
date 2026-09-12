# Hull

A dashboard-first tool that lets developers who don't know the cloud well declare what their application needs, then shows them which cloud resources that implies, what it costs, and how the pieces connect.

## Language

**Binding**:
The generated TypeScript access a tier gets to an intent it is linked to. Regenerated on every blueprint change and never hand-edited; a convenience over the link's language-agnostic contract.
_Avoid_: Client, SDK, helper

**Blueprint**:
The single declarative file in the repo that describes an application's architecture as a set of intents. The source of truth; the studio is a visual editor for it.
_Avoid_: Manifest, config, stack, infra file

**Environment**:
A named, deployed instance of the blueprint with its own state, such as dev or prod. It may override only the usage profile and the policies. Every resolution is the same kind in every environment; only sizing differs, following each environment's usage profile.
_Avoid_: Stage, stack, deployment target

**Intent**:
An architectural need declared in the blueprint, above the level of any cloud provider. "A relational database", "a decoupled queue between the API and the worker", "a user directory with groups".
_Avoid_: Resource, component, construct, building block

**Catalog**:
The curated, versioned set of intents, their candidate resolutions per provider, cost models, and recommendation rules. Closed: only maintainers add to it.
_Avoid_: Registry, library, plugin set

**Recommendation**:
The resolution the catalog's rules propose for an intent given the usage profile and policies, together with its trade-offs against the other candidates. Always proposed, never applied silently.
_Avoid_: Suggestion, default, auto-select, best practice

**Resolution**:
The concrete kind of cloud resources chosen to satisfy one intent on one provider, such as RDS Postgres rather than Aurora. Independent of sizing. An intent can have several candidate resolutions; one is chosen.
_Avoid_: Implementation, mapping, service choice

**Sizing**:
The capacity parameters of a resolution in one environment: instance class, memory, concurrency. Derived from that environment's usage profile unless an override pins it.
_Avoid_: Instance type, capacity, scale

**Override**:
An explicit, per-environment pin of a sizing parameter or resource property that replaces the derived value. Always shown as an override in the studio, never disguised as a derived value.
_Avoid_: Tweak, custom setting, manual config

**Usage profile**:
The blueprint's stated expected load: requests per month, active users, storage, messages. A new blueprint starts at a low-end profile. Every estimate and recommendation is relative to it.
_Avoid_: Assumptions, traffic model, load

**Estimate**:
The projected monthly cost of the blueprint at its usage profile, as a low/expected/high range, shown with and without free tier. Never an actual bill.
_Avoid_: Cost, price, bill, quote

**Policy**:
A blueprint-wide architectural decision that constrains how every intent is resolved, without owning resources of its own. Disaster recovery is the first.
_Avoid_: Setting, global option, strategy

**Disaster recovery**:
The policy stating how fast and how completely the application must come back after losing data or a whole region, expressed as a level: backup-and-restore, pilot light, warm standby, active-active. Distinct from high availability, which is a per-resolution option.
_Avoid_: DR strategy, resilience, backup plan

**Provider**:
A cloud platform a resolution targets: AWS, GCP. Every resolution belongs to exactly one provider; intents belong to none.
_Avoid_: Cloud, platform, vendor

**Resource**:
A concrete cloud primitive that exists in a provider account: an SQS queue, an RDS instance, a Cognito user pool.
_Avoid_: Service (ambiguous with cloud provider services), asset

**Link**:
A declared, directional connection from a tier to an intent (or to another tier), carrying a role. A link is the only thing that grants a tier access to an intent.
_Avoid_: Dependency, permission, edge, connection

**Role**:
The way a tier uses an intent through a link: produce, consume, read, read-write. The set of valid roles is defined per intent, not globally.
_Avoid_: Permission, access level, scope

**Studio**:
The local application opened from the CLI that hosts the dashboard and, later, other views such as administration. Every change made in it is a change to the blueprint file.
_Avoid_: Console, UI, app, editor

**Dashboard**:
The studio's primary view: the graph of tiers, intents, and links, the estimate, and the recommendations for the open blueprint.
_Avoid_: Overview, home, canvas

**Tier**:
A deployable unit of the application's own code that intents connect to or run on: an API, a background worker, a web frontend.
_Avoid_: Service, app, function
