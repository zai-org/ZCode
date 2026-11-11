import assert from "node:assert/strict";
import { createServer } from "node:https";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { build } from "esbuild";
import { _electron } from "playwright-core";
import forge from "node-forge";

const desktop = resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);
await mkdir(resolve(desktop, ".e2e-artifacts"), { recursive: true });
const artifact = await mkdtemp(resolve(desktop, ".e2e-artifacts/ca-constraints-"));
const home = resolve(artifact, "home");
await mkdir(resolve(home, ".zcode/v2"), { recursive: true });
const keys = Array.from({ length: 3 }, () => forge.pki.rsa.generateKeyPair(2048));
let serial = 2000;
const pem = forge.pki.certificateToPem;
const asn = forge.asn1;
const seq = (children) => asn.create(asn.Class.UNIVERSAL, asn.Type.SEQUENCE, true, children);
function certificate(name, key, issuer, signer, extensions, ca = false) {
  const cert = forge.pki.createCertificate();
  cert.publicKey = key.publicKey;
  cert.serialNumber = (++serial).toString(16);
  cert.validity.notBefore = new Date(Date.now() - 86400000);
  cert.validity.notAfter = new Date(Date.now() + 86400000);
  cert.setSubject([{ name: "commonName", value: name }]);
  cert.setIssuer(issuer?.subject.attributes ?? cert.subject.attributes);
  cert.setExtensions([{ name: "basicConstraints", critical: true, cA: ca }, ...extensions]);
  cert.sign(signer.privateKey, forge.md.sha256.create());
  return cert;
}
const usage = { name: "keyUsage", critical: true, keyCertSign: true };
const root = certificate("Constraint Root", keys[0], null, keys[0], [usage], true);
const caPath = resolve(artifact, "root.pem");
await writeFile(caPath, pem(root));
function constraint(permitted, excluded = [], minimum = 0) {
  const subtree = ([type, value]) =>
    seq([
      asn.create(asn.Class.CONTEXT_SPECIFIC, type, false, value),
      ...(minimum ? [asn.create(asn.Class.CONTEXT_SPECIFIC, 0, false, "\x01")] : []),
    ]);
  return {
    id: "2.5.29.30",
    critical: true,
    value: asn
      .toDer(
        seq([
          ...(permitted.length
            ? [asn.create(asn.Class.CONTEXT_SPECIFIC, 0, true, permitted.map(subtree))]
            : []),
          ...(excluded.length
            ? [asn.create(asn.Class.CONTEXT_SPECIFIC, 1, true, excluded.map(subtree))]
            : []),
        ]),
      )
      .getBytes(),
  };
}
const dns = (value) => [2, value];
const ip = (value) => [7, String.fromCharCode(...value)];
const parentDns = constraint([dns(".allowed.invalid")]);
const narrowDns = constraint([dns(".sub.allowed.invalid")]);
const parentIp = constraint([ip([127, 0, 0, 0, 255, 0, 0, 0])]);
const narrowIp = constraint([ip([127, 0, 0, 0, 255, 255, 0, 0])]);
const loopbackV6 = [...Array(15).fill(0), 1];
const exactV6 = constraint([ip([...loopbackV6, ...Array(16).fill(255)])]);
const rangeV6 = constraint([
  ip([...Array(16).fill(0), ...Array(8).fill(255), ...Array(8).fill(0)]),
]);
const badUsage = (value) => ({ id: "2.5.29.15", critical: true, value });
const definitions = [
  { name: "valid-dns", expected: true },
  {
    name: "ca-integer-key-usage",
    usage: badUsage(
      asn.toDer(asn.create(asn.Class.UNIVERSAL, asn.Type.INTEGER, false, "\x04")).getBytes(),
    ),
  },
  { name: "ca-undefined-usage-bit", usage: badUsage("\x03\x03\x00\x04\x01") },
  { name: "ca-crl-only", usage: { name: "keyUsage", critical: true, cRLSign: true } },
  {
    name: "dns-widen",
    parent: parentDns,
    child: constraint([dns(".evil.invalid")]),
    host: "host.evil.invalid",
  },
  { name: "dns-narrow", parent: parentDns, child: narrowDns, expected: true },
  {
    name: "dns-excluded",
    parent: parentDns,
    child: constraint([], [dns("host.sub.allowed.invalid")]),
  },
  {
    name: "dns-second-san-outside",
    parent: parentDns,
    child: narrowDns,
    extraNames: [{ type: 2, value: "host.evil.invalid" }],
  },
  { name: "ipv4-narrow", parent: parentIp, child: narrowIp, host: "127.0.0.1", expected: true },
  {
    name: "ipv4-widen",
    parent: constraint([ip([10, 0, 0, 0, 255, 0, 0, 0])]),
    child: narrowIp,
    host: "127.0.0.1",
  },
  {
    name: "ipv4-excluded",
    parent: parentIp,
    child: constraint([], [ip([127, 0, 0, 1, 255, 255, 255, 255])]),
    host: "127.0.0.1",
  },
  { name: "unsupported-mail-constraint", parent: constraint([[1, ".example.invalid"]]) },
  { name: "unsupported-minimum", parent: constraint([dns(".allowed.invalid")], [], 1) },
  { name: "constrained-wildcard", parent: parentDns, wildcard: true },
  { name: "constrained-cn-only", parent: parentDns, cnOnly: true },
  { name: "ipv6-narrow", parent: rangeV6, child: exactV6, host: "::1", expected: true },
  {
    name: "ipv6-widen",
    parent: constraint([ip([32, 1, ...Array(14).fill(0), ...Array(16).fill(255)])]),
    child: exactV6,
    host: "::1",
  },
  {
    name: "ipv6-excluded",
    parent: rangeV6,
    child: constraint([], [ip([...loopbackV6, ...Array(16).fill(255)])]),
    host: "::1",
  },
];
const cases = [];
const servers = [];
for (const d of definitions) {
  const parent = certificate(
    "Parent " + d.name,
    keys[1],
    root,
    keys[0],
    [d.usage ?? usage, ...(d.parent ? [d.parent] : [])],
    true,
  );
  const child = certificate(
    "Child " + d.name,
    keys[2],
    parent,
    keys[1],
    [usage, ...(d.child ? [d.child] : [])],
    true,
  );
  const host = d.host ?? "host.sub.allowed.invalid";
  const names =
    host === "127.0.0.1" || host === "::1"
      ? [{ type: 7, ip: host }]
      : [{ type: 2, value: d.wildcard ? "*.sub.allowed.invalid" : host }];
  const leaf = certificate(host, keys[0], child, keys[2], [
    { name: "keyUsage", critical: true, digitalSignature: true },
    ...(!d.cnOnly
      ? [{ name: "subjectAltName", altNames: [...names, ...(d.extraNames ?? [])] }]
      : []),
  ]);
  const chain = [leaf, child, parent, root].map((cert) => pem(cert));
  const server = createServer(
    { key: forge.pki.privateKeyToPem(keys[0].privateKey), cert: chain.join("") },
    (_req, res) => res.end("verified"),
  );
  await new Promise((done) => server.listen(0, host === "::1" ? "::1" : "127.0.0.1", done));
  servers.push(server);
  cases.push({
    name: d.name,
    host,
    chain,
    port: server.address().port,
    expected: d.expected ?? false,
  });
}
// 显式配置的单证书锚不必具备 CA 签发用途，但仍受叶证书的全部安全约束。
const directAnchors = [pem(root)];
for (const definition of [
  { name: "self-signed-ca-false", expected: true },
  { name: "self-signed-ca-true-signature-only", ca: true, expected: true },
  { name: "self-signed-wrong-host", wrongHost: true },
  { name: "self-signed-expired", expired: true },
  { name: "self-signed-future", future: true },
  { name: "self-signed-wrong-signature", wrongSignature: true },
  { name: "self-signed-unknown-critical", unknownCritical: true },
  { name: "self-signed-crl-only", crlOnly: true },
  { name: "self-signed-rsa-1024", weakKey: true },
  { name: "self-signed-unconfigured", unconfigured: true },
  { name: "self-signed-sha1", sha1: true },
  { name: "self-signed-client-only", clientOnly: true },
]) {
  const key = definition.weakKey ? forge.pki.rsa.generateKeyPair(1024) : keys[0];
  const extensions = [
    {
      name: "keyUsage",
      critical: true,
      digitalSignature: !definition.crlOnly,
      cRLSign: !!definition.crlOnly,
    },
    {
      name: "subjectAltName",
      altNames: [{ type: 7, ip: definition.wrongHost ? "127.0.0.2" : "127.0.0.1" }],
    },
    {
      name: "extKeyUsage",
      serverAuth: !definition.clientOnly,
      clientAuth: !!definition.clientOnly,
    },
  ];
  if (definition.unknownCritical)
    extensions.push({
      id: "1.2.3.4.5.6.7.8.1",
      critical: true,
      value: asn.toDer(seq([])).getBytes(),
    });
  const anchor = certificate(definition.name, key, null, key, extensions, !!definition.ca);
  if (definition.expired) anchor.validity.notAfter = new Date(Date.now() - 3600000);
  if (definition.future) anchor.validity.notBefore = new Date(Date.now() + 3600000);
  anchor.sign(
    definition.wrongSignature ? keys[1].privateKey : key.privateKey,
    definition.sha1 ? forge.md.sha1.create() : forge.md.sha256.create(),
  );
  const value = pem(anchor);
  if (!definition.unconfigured) directAnchors.push(value);
  const server = createServer(
    { key: forge.pki.privateKeyToPem(key.privateKey), cert: value, ciphers: "DEFAULT:@SECLEVEL=0" },
    (_req, res) => res.end("verified"),
  );
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  servers.push(server);
  cases.push({
    name: definition.name,
    host: "127.0.0.1",
    chain: [value],
    port: server.address().port,
    expected: definition.expected ?? false,
  });
}
// CA 文件常被直接配置为 fullchain；附带叶证书不得抢先成为常规建链的锚。
const bundleRoot = certificate("Bundle Root", keys[0], null, keys[0], [usage], true);
const bundleIntermediate = certificate(
  "Bundle Intermediate",
  keys[1],
  bundleRoot,
  keys[0],
  [usage],
  true,
);
const pinIssuer = certificate("Unconfigured Pin Issuer", keys[0], null, keys[0], [usage], true);
for (const definition of [
  { name: "bundle-root-and-leaf", expected: true },
  { name: "bundle-full-chain", intermediate: true, expected: true },
  { name: "bundle-ca-flag-leaf-signature-only", ca: true, expected: true },
  { name: "pinned-non-self-issued", pinOnly: true, expected: false },
]) {
  const issuer = definition.pinOnly
    ? pinIssuer
    : definition.intermediate
      ? bundleIntermediate
      : bundleRoot;
  const leaf = certificate(
    definition.name,
    keys[2],
    issuer,
    definition.intermediate ? keys[1] : keys[0],
    [
      { name: "keyUsage", critical: true, digitalSignature: true },
      { name: "subjectAltName", altNames: [{ type: 7, ip: "127.0.0.1" }] },
      { name: "extKeyUsage", serverAuth: true },
    ],
    !!definition.ca,
  );
  const configured = definition.pinOnly
    ? [leaf]
    : definition.intermediate
      ? [leaf, bundleIntermediate, bundleRoot]
      : [bundleRoot, leaf];
  directAnchors.push(...configured.map(pem));
  const chain = [leaf, ...(definition.intermediate ? [bundleIntermediate] : [])].map(pem);
  const server = createServer(
    { key: forge.pki.privateKeyToPem(keys[2].privateKey), cert: chain.join("") },
    (_req, res) => res.end("verified"),
  );
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  servers.push(server);
  cases.push({
    name: definition.name,
    host: "127.0.0.1",
    chain,
    port: server.address().port,
    expected: definition.expected,
  });
}
await writeFile(caPath, directAnchors.join("\n"));
await writeFile(
  resolve(home, ".zcode/v2/setting.json"),
  JSON.stringify({
    locale: "en-US",
    httpProxyCaCertPath: caPath,
    embeddedBrowserAllowInsecureCertificates: true,
    autoDownloadAndInstallUpdates: false,
  }),
);
const appArg = process.argv.indexOf("--app");
await writeFile(resolve(artifact, "cases.json"), JSON.stringify(cases, null, 2));
const executable = appArg >= 0 ? process.argv[appArg + 1] : require("electron");
assert(executable, "--app requires an executable");
const entry = resolve(artifact, "main.mjs");
if (appArg < 0) {
  await build({
    stdin: {
      resolveDir: desktop,
      contents: `
      import {app, BrowserWindow, session} from 'electron';
      import {readFile} from 'node:fs/promises';
      import {applyDesktopChromiumNetworkPolicies, createCustomCaCertificateVerifyProc, readCustomCaCertificatesFromPem} from './src/main/desktopNetworkPolicy.ts';
      void (async () => {
      app.setPath('userData', ${JSON.stringify(resolve(artifact, "user-data"))});
      await app.whenReady();
      await applyDesktopChromiumNetworkPolicies(session,{httpProxyCaCertPath:${JSON.stringify(caPath)}}, {info(){},warn(){}});
      globalThis.verifyPolicy=createCustomCaCertificateVerifyProc(readCustomCaCertificatesFromPem(await readFile(${JSON.stringify(caPath)},'utf8')));
      const window = new BrowserWindow({show:false});
      await window.loadURL('data:text/html,CA%20constraints');
      })().catch(error => { console.error(error); app.exit(1); });
    `,
    },
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: entry,
    external: ["electron", "electron-updater", "pkijs"],
    plugins: [
      {
        name: "unused-browser-partition",
        setup(b) {
          b.onResolve({ filter: /^\.\/browserDataManager\.js$/ }, () => ({
            path: "partition",
            namespace: "fixture",
          }));
          b.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
            contents: 'export const EMBEDDED_BROWSER_PARTITION="persist:embedded-browser";',
          }));
        },
      },
    ],
  });
}
const env = {
  ...process.env,
  HOME: home,
  ZCODE_DATA_BASE_DIR: home,
  ZCODE_DESKTOP_HOME_DIR: home,
  ZCODE_DESKTOP_USER_DATA_DIR: resolve(artifact, "user-data"),
  ZCODE_DESKTOP_SESSION_DATA_DIR: resolve(artifact, "session"),
  ZCODE_DESKTOP_APPLICATION_NAME: "ZCode CA Constraints Acceptance",
};
delete env.ELECTRON_RUN_AS_NODE;
let application;
let output = "";
try {
  application = await _electron.launch({
    executablePath: executable,
    args: [...(appArg < 0 ? [entry] : []), "--host-resolver-rules=MAP *.invalid 127.0.0.1"],
    env,
    cwd: home,
  });
  for (const stream of [application.process().stdout, application.process().stderr])
    stream?.on("data", (data) => {
      output += data;
      process.stdout.write(data);
    });
  await application.firstWindow();
  const result = await application.evaluate(async ({ app }, inputs) => {
    const { createRequire } = process.getBuiltinModule("node:module");
    const { autoUpdater, CancellationToken } = createRequire(app.getAppPath() + "/package.json")(
      "electron-updater",
    );
    const results = [];
    for (const c of inputs) {
      console.info("CA constraint case", c.name);
      let policyCode;
      if (globalThis.verifyPolicy) {
        let certificate;
        for (const data of [...c.chain].reverse()) certificate = { data, issuerCert: certificate };
        policyCode = await new Promise((done) =>
          globalThis.verifyPolicy({ hostname: c.host, errorCode: -202, certificate }, done),
        );
      }
      const token = new CancellationToken();
      let accepted = false,
        timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        token.cancel();
      }, 5000);
      try {
        accepted =
          (await autoUpdater.httpExecutor.request(
            { protocol: "https:", hostname: c.host, port: c.port, path: "/" },
            token,
          )) === "verified";
      } catch {
      } finally {
        clearTimeout(timer);
      }
      results.push({ name: c.name, expected: c.expected, policyCode, accepted, timedOut });
    }
    return { version: app.getVersion(), packaged: app.isPackaged, results };
  }, cases);
  await writeFile(resolve(artifact, "result.json"), JSON.stringify(result, null, 2));
  for (const c of result.results) {
    if (appArg < 0) assert.equal(c.policyCode, c.expected ? 0 : -3, c.name + " policy");
    assert.equal(c.timedOut, false, c.name + " timeout");
    assert.equal(c.accepted, c.expected, c.name + " HTTPS");
  }
  console.log(JSON.stringify({ artifact, passed: cases.length, ...result }));
} finally {
  await writeFile(resolve(artifact, "application.log"), output);
  await application?.close();
  await Promise.all(
    servers.map(
      (server) =>
        new Promise((done) => {
          server.closeAllConnections();
          server.close(done);
        }),
    ),
  );
  console.log("CA_CONSTRAINTS_ARTIFACT", artifact);
}
