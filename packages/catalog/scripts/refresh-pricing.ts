// Refreshes pricing/aws.json from the AWS Price List Bulk API for one region:
// `pnpm refresh-pricing [--region us-east-1]`. No credentials: the offer
// files are public. The free tier block is verified by hand (README) and
// carried over from the file on disk; every price is replaced.
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { freeTierSchema } from "../src/pricing-schema.js";
import { offerCodes, offerFileSchema, offerUrl, refreshPrices, skuCount, type OfferFiles } from "../src/refresh.js";

const { values } = parseArgs({ options: { region: { type: "string", default: "us-east-1" } } });
const region = values.region;

const offers = Object.fromEntries(
  await Promise.all(
    offerCodes.map(async (offerCode) => {
      const response = await fetch(offerUrl(offerCode, region));
      if (!response.ok) throw new Error(`${offerUrl(offerCode, region)} answered ${response.status}`);
      return [offerCode, offerFileSchema.parse(await response.json())] as const;
    }),
  ),
) as OfferFiles;

// Only the free tier block of the file on disk is read: the prices are
// replaced whatever shape they had.
const target = new URL("../pricing/aws.json", import.meta.url);
const freeTier = freeTierSchema.parse((JSON.parse(readFileSync(target, "utf8")) as { freeTier: unknown }).freeTier);
const snapshot = refreshPrices(offers, region, freeTier);
writeFileSync(target, `${JSON.stringify(snapshot, null, 2)}\n`);
console.log(`wrote ${target.pathname} from ${skuCount} SKUs; ${snapshot.source}`);
