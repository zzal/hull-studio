# PROTOTYPE: VPC-attached Lambda reach without NAT (phase 0 of milestone 2)

Throwaway. Answers one question:

> From a Lambda attached to the default VPC with no NAT gateway, do calls
> to Secrets Manager and SQS succeed with no VPC endpoint? And do they with
> one interface endpoint per service?

Run: `pnpm install && AWS_PROFILE=<sandbox profile> pnpm start`. Deploys a
security group, a secret, a queue, a role and a Lambda attached to every
subnet of the default VPC; invokes it and prints the outcome of each call
(success or failure with the time it took); adds a Secrets Manager and an
SQS interface endpoint in one subnet, private DNS on, invokes again and
prints; destroys everything and removes the stack. State in the local file
backend under `~/.pulumi`, passphrase `spike`. Cost: the endpoints are
about USD 0.01 an hour each while the run lasts, the rest is within the
always-free allowances; the run leaves nothing behind.

## Verdict: not yet measured

The script was written in the session that built milestone 2 and has not
been run: it needs a sandbox account. Until it runs, ADR 0008 records the
provisional verdict "no endpoints needed", on the strength of the
milestone 1 demo (an API attached to the default VPC fetched its managed
master password from Secrets Manager on a real account), against what AWS
documents (a VPC-attached function has no public address and reaches a
public regional endpoint only through a NAT gateway or an interface
endpoint).

When it runs, record here the account and region, the two printed
outcomes, and the time each call took, then settle ADR 0008:

- both calls succeed without endpoints: the ADR loses "provisional" and
  gains the explanation (which path the traffic took);
- both fail without endpoints and succeed with them: the ADR's "if
  endpoints are needed" section becomes the decision, the compiler ticket
  (#21) gains the endpoints and the catalog ticket (#18) the SKU.
