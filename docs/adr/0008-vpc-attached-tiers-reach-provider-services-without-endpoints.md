# VPC-attached tiers reach provider services without endpoints (provisional)

A tier is attached to the default VPC only when it links a relational
database, since the database is private; a tier linked only to a queue
stays outside the VPC. Milestone 2 records the verdict that a VPC-attached
Lambda reaches Secrets Manager and SQS without a NAT gateway and without
interface endpoints, so the compiler declares no endpoint and the estimate
counts none.

## Status

Provisional. The verdict rests on the one measurement that exists: the
milestone 1 demo, whose API is attached to the default VPC and fetched its
managed master password from Secrets Manager on every cold start, ran end
to end on a real account. The phase 0 spike this milestone planned, a
throwaway Lambda in a fresh default VPC calling both services with and
without endpoints, was written on the `prototype/vpc-reach` branch but not
run in the session that built the milestone: it needs a sandbox account.
Running it is the first step of the manual acceptance test, and its outcome
either confirms this decision or replaces it.

## What AWS documents

A function attached to a VPC gets a hyperplane network interface with a
private address only. Its traffic to a public regional endpoint such as
`secretsmanager.us-east-1.amazonaws.com` follows the subnet's route table;
in a default VPC the route to the internet gateway exists but carries no
public address for the interface, so the documented path to a provider
service from inside a VPC is a NAT gateway or an interface endpoint of the
service. That is the reason the spike was planned: the milestone 1 run
succeeded where the documentation says it should not have, and the
difference (a Lambda-specific path, the account's VPC configuration, or a
misread of the run) is what the spike measures.

## If endpoints are needed

The compiler declares one interface endpoint per provider service a
VPC-attached tier links to, once per stack (Secrets Manager when a database
is linked, SQS when a queue is linked from a VPC-attached tier), in one
subnet, and the catalog adds the endpoint hour to the resources of
`rds-postgres` and `sqs-standard` and its SKU (offer code `AmazonVPC`,
usage type `VpcEndpoint-Hours`) to the pricing refresh. At the snapshot's
sources an interface endpoint is about USD 0.01 an hour per availability
zone, about USD 7 a month each; two endpoints in one zone add about USD 15
a month to an environment, which the estimate must show. The "no NAT
gateway" sentence in the README gains "and one interface endpoint per
linked provider service".

## Considered options

- Declare the endpoints now, to be safe: adds about USD 15 a month to every
  environment with a database, which is more than the database costs in
  dev, on the strength of documentation the only real run contradicts.
- Attach every tier to the VPC, as milestone 1 did: pays for the attachment
  where nothing needs it and keeps the question open for the worker.
