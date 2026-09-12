# Environments share resolution kind, not sizing

An environment may override only the usage profile and the policies. Every resolution is the same kind in every environment (RDS Postgres in dev means RDS Postgres in prod); only sizing differs, derived from each environment's usage profile or pinned by an explicit override. Per-environment resolution choices (Aurora in prod, plain RDS in dev) were rejected because they are the structural differences that cause "works in dev" failures, and cheaper sizing already addresses the cost concern. Users who need that flexibility have SST.
