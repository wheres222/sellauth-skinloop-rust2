import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const run = (args) => execFileSync("wrangler", args, {
  encoding: "utf8",
  stdio: ["inherit", "pipe", "inherit"],
});
const parse = (text, label) => {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`wrangler returned invalid JSON for ${label}`);
  }
};

const d1Name = process.env.D1_NAME || "sellauth-skinloop-rust";
const queueName = process.env.QUEUE_NAME || "sellauth-skinloop-rust-fulfillment";
const dlqName = process.env.DLQ_NAME || "sellauth-skinloop-rust-dead-letter";

const queueResponse = parse(run(["queues", "list", "--json"]), "queues");
const queues = Array.isArray(queueResponse) ? queueResponse : queueResponse.queues || [];
const queueNames = new Set(queues.map((queue) => queue.queue_name || queue.name));
if (!queueNames.has(queueName)) run(["queues", "create", queueName]);
if (!queueNames.has(dlqName)) run(["queues", "create", dlqName]);

const d1Response = parse(run(["d1", "list", "--json"]), "D1 databases");
const databases = Array.isArray(d1Response) ? d1Response : d1Response.databases || [];
const existing = databases.find((database) =>
  (database.name || database.database_name) === d1Name
);
const created = existing || parse(run(["d1", "create", d1Name, "--json"]), "D1 create");
const databaseId = existing?.uuid || existing?.database_id ||
  created.uuid || created.database_id;
if (!databaseId) throw new Error("D1 response did not contain a database id");

let config = readFileSync("wrangler.toml", "utf8");
config = config.replace(/database_id = "[^"]*"/, `database_id = "${databaseId}"`);
writeFileSync("wrangler.toml", config);

run(["d1", "migrations", "apply", d1Name, "--remote"]);
console.log(`Provisioned D1 ${d1Name}, queue ${queueName}, DLQ ${dlqName}, and applied migrations.`);