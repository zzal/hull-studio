# @hull/catalog

Intents, candidate resolutions per provider, sizing derivation, cost models,
the pricing snapshot and the recommendation rules. See the repository README
for how the package fits, and `CONTEXT.md` for the vocabulary.

## Pricing snapshot

`pricing/aws.json` holds the on-demand us-east-1 prices of exactly the SKUs
the three v0 resolutions use, and the free tier rules beside them. The cost
models read both; nothing about a price or an allowance is in code.

```bash
pnpm -F @hull/catalog refresh-pricing            # us-east-1
pnpm -F @hull/catalog refresh-pricing --region eu-west-1
```

The script downloads the current offer file of each of the six offer codes
from the AWS Price List Bulk API (public URLs, no credentials), picks the
sixteen SKUs by their attributes, and rewrites the file. `publishedAt` is the
newest offer file's publication date and `source` names each file's version,
so a rerun on the same offer files writes the same bytes; the diff of a refresh is
the price change and nothing else. Multi-AZ instance hours and storage are
their own SKUs and are kept as such: `db.t4g.small` Multi-AZ is USD 0.065
an hour, not twice 0.032, which is why the snapshot holds no "multiply by
two" factor.

| Resolution | SKUs |
|---|---|
| `lambda-api-gateway` | Lambda requests, Lambda GB-seconds (x86, first tier), API Gateway HTTP API requests (first tier) |
| `rds-postgres` | PostgreSQL `db.t4g.micro`, `small`, `medium` instance hours, Single-AZ and Multi-AZ; gp3 storage, Single-AZ and Multi-AZ; the Secrets Manager secret holding the managed master password |
| `fargate-load-balancer` | Fargate Linux x86 vCPU-hour and GB-hour; Application Load Balancer hour and capacity-unit hour |

The `freeTier` block is not refreshed: it is verified by hand, dated
(`verifiedAt`) and sourced (`sources`), and the script carries it over
untouched. Change it by editing the file and this write-up together.

## Free tier: what the estimate assumes, and why

Verified on 2026-09-14 against the sources listed in the snapshot.

**What AWS changed.** On July 15, 2025 AWS replaced the 12-month free tier
for new accounts with a credit-based model: a new account gets USD 100 in
credits at sign-up and can earn up to USD 100 more by trying a few services,
on a free plan that ends after six months or when the credits run out, or
on a paid plan where the credits offset the first bills. The credits expire
twelve months after the account is opened. Accounts opened before that date
kept their 12-month offers for the remainder of their twelve months.
Sources: the announcement of July 16, 2025 (`whats-new/2025/07`), the
Billing guide's free tier page, the Free Tier page and its terms and FAQ.

**What is left for every account.** The always-free offers, on both the
free and the paid plan, for as long as the account exists. Of the SKUs the
snapshot prices, only Lambda has one: one million requests and 400,000
GB-seconds a month (Lambda pricing page, Free Tier page under Always Free).
API Gateway's one million HTTP API requests, RDS's 750 hours of
`db.t4g.micro` with 20 GB of storage, and the load balancer's 750 hours with
15 capacity-unit hours were all 12-month offers.

**Why the 12-month offers are gone from the snapshot.** They were closed to
accounts opened on or after July 15, 2025, and every account opened before
that date had used up its twelve months by July 15, 2026. As of this
verification no account can hold them, so modelling them would only
overstate what is free.

**Why the credits are not modelled.** They are a balance against the whole
bill, not an allowance on a SKU: the estimate is per intent and per month,
and the credits are per account and one-off. A developer on a fresh
account will see their first months covered by the credits; the estimate
shows what the bill is once they are spent, which is what the estimate is
for. If the estimate ever gets an account-level view, the credits belong
there.

**What the estimate shows.** Two figures: without free tier, the full
on-demand price; with free tier, labelled "always-free allowances only",
the same minus Lambda's allowance drawn once for the account across every
intent, in blueprint order. For the sample blueprint's dev environment that
makes the API free apart from its gateway requests, and the database not
free at all.

**When to look again.** If AWS adds an always-free offer for one of these
SKUs, restores a 12-month offer, or changes Lambda's allowance: edit the
`freeTier` block, bump `verifiedAt`, and update this section and the
estimate tests in `packages/studio/src/estimate.test.ts`, which work the
sample figures by hand from the snapshot.
