import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { build } from "esbuild";
import { _electron } from "playwright-core";

// 用真实 updater Session 和 HTTP executor 验证出口，不改用户配置或下载真实安装包。
const desktopDir = resolve(import.meta.dirname, "..");
const require = createRequire(resolve(desktopDir, "package.json"));
await mkdir(resolve(desktopDir, ".e2e-artifacts"), { recursive: true });
const artifactDir = await mkdtemp(resolve(desktopDir, ".e2e-artifacts/update-network-"));
// 正式主进程使用 ESM；CJS fixture 会掩盖第三方 CommonJS 包的命名导入错误。
const entry = resolve(artifactDir, "main.mjs");

async function runFixture() {
  const { app, BrowserWindow, session } = await import("electron");
  const { createServer } = await import("node:http");
  const { createHash } = await import("node:crypto");
  const { readFile, writeFile } = await import("node:fs/promises");
  const { createServer: createHttpsServer } = await import("node:https");
  const { default: forge } = await import("node-forge");
  const { default: pkg, CancellationToken } = await import("electron-updater");
  const {
    applyDesktopChromiumNetworkPolicies,
    createCustomCaCertificateVerifyProc,
    readCustomCaCertificatesFromPem,
  } = await import("./src/main/desktopNetworkPolicy.ts");
  app.setPath("userData", FIXTURE_DIR + "/user-data");
  await app.whenReady();
  const { autoUpdater } = pkg;
  const bytes = Buffer.alloc(256 * 1024, 37);
  const requests = [];
  const policyLogs = [];
  const policyLogger = {
    info: (message) => {
      policyLogs.push(String(message));
      console.info(message);
    },
    warn: (...args) => console.warn(...args),
  };
  let interrupt = false;
  const proxy = createServer((req, res) => {
    requests.push(req.url);
    res.writeHead(200, { "Content-Length": bytes.length });
    if (interrupt) {
      interrupt = false;
      res.write(bytes.subarray(0, 4096));
      setImmediate(() => res.destroy());
    } else res.end(bytes);
  });
  const direct = createServer((_req, res) => res.end("bypassed"));
  await Promise.all(
    [proxy, direct].map(
      (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", resolve)),
    ),
  );
  await applyDesktopChromiumNetworkPolicies(
    session,
    {
      httpProxy: "http://127.0.0.1:" + proxy.address().port,
      httpProxyNoProxy: "127.0.0.1",
      embeddedBrowserAllowInsecureCertificates: true,
    },
    policyLogger,
  );
  const updater = autoUpdater.netSession;
  const route = await updater.resolveProxy("http://update-download.invalid/package.zip");
  globalThis.fixtureRoute = route;
  const sha512 = createHash("sha512").update(bytes).digest("base64");
  const destination = FIXTURE_DIR + "/package.zip";
  const options = () => ({ cancellationToken: new CancellationToken(), sha512 });
  globalThis.runDownload = async () => {
    interrupt = true;
    let interrupted = false;
    try {
      await autoUpdater.httpExecutor.download(
        new URL("http://update-download.invalid/interrupted.zip"),
        destination,
        options(),
      );
    } catch {
      interrupted = true;
    }
    await autoUpdater.httpExecutor.download(
      new URL("http://update-download.invalid/package.zip"),
      destination,
      options(),
    );
    const bypass = await autoUpdater.httpExecutor.request({
      protocol: "http:",
      hostname: "127.0.0.1",
      port: direct.address().port,
      path: "/bypass",
    });
    const keys = forge.pki.rsa.generateKeyPair(2048);
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = "01";
    cert.validity.notBefore = new Date(Date.now() - 60 * 60_000);
    cert.validity.notAfter = new Date(Date.now() + 24 * 60 * 60_000);
    cert.setSubject([{ name: "commonName", value: "localhost" }]);
    cert.setIssuer(cert.subject.attributes);
    cert.setExtensions([
      { name: "basicConstraints", cA: true },
      { name: "subjectAltName", altNames: [{ type: 7, ip: "127.0.0.1" }] },
    ]);
    cert.sign(keys.privateKey, forge.md.sha256.create());
    const pem = forge.pki.certificateToPem(cert);
    const tls = createHttpsServer(
      { key: forge.pki.privateKeyToPem(keys.privateKey), cert: pem },
      (_req, res) => res.end("trusted"),
    );
    await new Promise((resolve) => tls.listen(0, "127.0.0.1", resolve));
    const tlsOptions = {
      protocol: "https:",
      hostname: "127.0.0.1",
      port: tls.address().port,
      path: "/",
    };
    let rejectedUntrusted = false;
    try {
      await autoUpdater.httpExecutor.request(tlsOptions);
    } catch {
      rejectedUntrusted = true;
    }
    // 使用另一张证书，避免 Chromium 复用上一轮对相同证书的负缓存。
    cert.serialNumber = "02";
    cert.sign(keys.privateKey, forge.md.sha256.create());
    const trustedPem = forge.pki.certificateToPem(cert);
    tls.setSecureContext({ key: forge.pki.privateKeyToPem(keys.privateKey), cert: trustedPem });
    const caPath = FIXTURE_DIR + "/fixture-ca.pem";
    await writeFile(caPath, trustedPem);
    await applyDesktopChromiumNetworkPolicies(
      session,
      {
        httpProxy: "http://127.0.0.1:" + proxy.address().port,
        httpProxyNoProxy: "127.0.0.1",
        httpProxyCaCertPath: caPath,
        embeddedBrowserAllowInsecureCertificates: true,
      },
      policyLogger,
    );
    const trusted = await autoUpdater.httpExecutor.request(tlsOptions);
    // 自定义根只增加信任，不能使其它 TLS 错误变成成功。
    const rootKeys = forge.pki.rsa.generateKeyPair(2048);
    const leafKeys = forge.pki.rsa.generateKeyPair(2048);
    const rootCert = forge.pki.createCertificate();
    rootCert.publicKey = rootKeys.publicKey;
    rootCert.serialNumber = "100";
    rootCert.validity.notBefore = new Date(Date.now() - 86400000);
    rootCert.validity.notAfter = new Date(Date.now() + 86400000);
    rootCert.setSubject([{ name: "commonName", value: "Fixture Root" }]);
    rootCert.setIssuer(rootCert.subject.attributes);
    rootCert.setExtensions([
      { name: "basicConstraints", critical: true, cA: true },
      { name: "keyUsage", critical: true, keyCertSign: true },
    ]);
    rootCert.sign(rootKeys.privateKey, forge.md.sha256.create());
    const rootPem = forge.pki.certificateToPem(rootCert);
    await writeFile(caPath, rootPem);
    await applyDesktopChromiumNetworkPolicies(
      session,
      { httpProxyCaCertPath: caPath, embeddedBrowserAllowInsecureCertificates: true },
      policyLogger,
    );
    const boundary = {};
    const weakKeys = forge.pki.rsa.generateKeyPair(1024);
    for (const [index, name] of [
      "valid-root",
      "valid-intermediate",
      "aki-intermediate-serial",
      "nonca-intermediate",
      "pathlen-blocked",
      "wrong-host",
      "expired",
      "not-yet-valid",
      "wrong-signature",
      "client-only",
      "sha1-signed",
      "rsa-1024",
    ].entries()) {
      const leaf = forge.pki.createCertificate();
      leaf.publicKey = name === "rsa-1024" ? weakKeys.publicKey : leafKeys.publicKey;
      leaf.serialNumber = (200 + index).toString(16);
      leaf.validity.notBefore = new Date(
        Date.now() + (name === "not-yet-valid" ? 86400000 : -86400000),
      );
      leaf.validity.notAfter = new Date(Date.now() + (name === "expired" ? -3600000 : 172800000));
      leaf.setSubject([
        { name: "commonName", value: name === "wrong-host" ? "wrong.invalid" : "127.0.0.1" },
      ]);
      const hasIntermediate = [
        "valid-intermediate",
        "aki-intermediate-serial",
        "nonca-intermediate",
        "pathlen-blocked",
      ].includes(name);
      const currentRoot = forge.pki.certificateFromPem(rootPem);
      currentRoot.serialNumber = (400 + index).toString(16);
      currentRoot.setExtensions([
        {
          name: "basicConstraints",
          critical: true,
          cA: true,
          pathLenConstraint: name === "pathlen-blocked" ? 0 : 1,
        },
        { name: "keyUsage", critical: true, keyCertSign: true },
      ]);
      currentRoot.sign(rootKeys.privateKey, forge.md.sha256.create());
      const currentRootPem = forge.pki.certificateToPem(currentRoot);
      await writeFile(caPath, currentRootPem);
      await applyDesktopChromiumNetworkPolicies(
        session,
        { httpProxyCaCertPath: caPath, embeddedBrowserAllowInsecureCertificates: true },
        policyLogger,
      );
      const intermediate = forge.pki.createCertificate();
      intermediate.publicKey = keys.publicKey;
      intermediate.serialNumber = (500 + index).toString(16);
      intermediate.validity.notBefore = rootCert.validity.notBefore;
      intermediate.validity.notAfter = rootCert.validity.notAfter;
      intermediate.setSubject([{ name: "commonName", value: "Fixture Intermediate" }]);
      intermediate.setIssuer(currentRoot.subject.attributes);
      intermediate.setExtensions([
        { name: "basicConstraints", critical: true, cA: name !== "nonca-intermediate" },
        { name: "keyUsage", critical: true, keyCertSign: true },
      ]);
      intermediate.sign(rootKeys.privateKey, forge.md.sha256.create());
      leaf.setIssuer(
        hasIntermediate ? intermediate.subject.attributes : currentRoot.subject.attributes,
      );
      leaf.setExtensions([
        { name: "basicConstraints", critical: true, cA: false },
        {
          name: "subjectAltName",
          altNames:
            name === "wrong-host"
              ? [{ type: 2, value: "wrong.invalid" }]
              : [{ type: 7, ip: "127.0.0.1" }],
        },
        {
          name: "extKeyUsage",
          serverAuth: name !== "client-only",
          clientAuth: name === "client-only",
        },
      ]);
      if (name === "aki-intermediate-serial") {
        leaf.setExtensions([
          ...leaf.extensions,
          {
            name: "authorityKeyIdentifier",
            authorityCertIssuer: intermediate.issuer,
            serialNumber: intermediate.serialNumber,
          },
        ]);
      }
      leaf.sign(
        name === "wrong-signature" || hasIntermediate ? keys.privateKey : rootKeys.privateKey,
        name === "sha1-signed" ? forge.md.sha1.create() : forge.md.sha256.create(),
      );
      const server = createHttpsServer(
        {
          key: forge.pki.privateKeyToPem(
            name === "rsa-1024" ? weakKeys.privateKey : leafKeys.privateKey,
          ),
          cert:
            forge.pki.certificateToPem(leaf) +
            (hasIntermediate ? forge.pki.certificateToPem(intermediate) : "") +
            currentRootPem,
        },
        (_req, res) => res.end("verified"),
      );
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      try {
        boundary[name] = {
          accepted:
            (await autoUpdater.httpExecutor.request({
              protocol: "https:",
              hostname: "127.0.0.1",
              port: server.address().port,
              path: "/",
            })) === "verified",
        };
      } catch {
        boundary[name] = { accepted: false };
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    }
    // 叶证书没有进入 PKIjs 的 CA 扩展检查；同时核对策略返回值及真实 HTTPS 请求。
    await writeFile(caPath, rootPem);
    await applyDesktopChromiumNetworkPolicies(
      session,
      { httpProxyCaCertPath: caPath },
      policyLogger,
    );
    for (const [index, name] of [
      "critical-unknown",
      "noncritical-unknown",
      "critical-unsupported",
      "usage-crl-only",
      "usage-key-encipherment-only",
      "usage-key-agreement-only",
      "usage-digital-signature",
      "usage-signature-and-encipherment",
      "usage-absent",
    ].entries()) {
      const leaf = forge.pki.createCertificate();
      leaf.publicKey = leafKeys.publicKey;
      leaf.serialNumber = (1000 + index).toString(16);
      leaf.validity = rootCert.validity;
      leaf.setSubject([{ name: "commonName", value: "127.0.0.1" }]);
      leaf.setIssuer(rootCert.subject.attributes);
      const extensions = [
        { name: "basicConstraints", critical: true, cA: false },
        { name: "subjectAltName", altNames: [{ type: 7, ip: "127.0.0.1" }] },
        { name: "extKeyUsage", serverAuth: true },
      ];
      if (name.includes("unknown") || name === "critical-unsupported") {
        extensions.push({
          id: name === "critical-unsupported" ? "2.5.29.16" : "1.2.3.4.5.6.7.8.1",
          critical: name !== "noncritical-unknown",
          value: forge.asn1
            .toDer(
              forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SEQUENCE, true, []),
            )
            .getBytes(),
        });
      } else if (name !== "usage-absent") {
        extensions.push({
          name: "keyUsage",
          critical: true,
          digitalSignature:
            name.includes("digital-signature") || name === "usage-signature-and-encipherment",
          keyEncipherment: name.includes("encipherment"),
          keyAgreement: name.includes("agreement"),
          cRLSign: name === "usage-crl-only",
        });
      }
      leaf.setExtensions(extensions);
      leaf.sign(rootKeys.privateKey, forge.md.sha256.create());
      const pem = forge.pki.certificateToPem(leaf);
      const verify = createCustomCaCertificateVerifyProc(readCustomCaCertificatesFromPem(rootPem));
      const policyCode = await new Promise((resolve) =>
        verify(
          {
            hostname: "127.0.0.1",
            errorCode: -202,
            certificate: { data: pem, issuerCert: { data: rootPem } },
          },
          resolve,
        ),
      );
      const server = createHttpsServer(
        { key: forge.pki.privateKeyToPem(leafKeys.privateKey), cert: pem + rootPem },
        (_req, res) => res.end("verified"),
      );
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      try {
        boundary[name] = {
          policyCode,
          accepted:
            (await autoUpdater.httpExecutor.request({
              protocol: "https:",
              hostname: "127.0.0.1",
              port: server.address().port,
              path: "/",
            })) === "verified",
        };
      } catch {
        boundary[name] = { policyCode, accepted: false };
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    }
    for (const [index, oid] of ["2.5.29.15", "2.5.29.30", "2.5.29.32", "2.5.29.30-ca"].entries()) {
      const intermediateCase = oid.endsWith("-ca");
      const invalidExtension = {
        id: oid.replace("-ca", ""),
        critical: true,
        value: forge.asn1
          .toDer(
            forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.INTEGER, false, "\x80"),
          )
          .getBytes(),
      };
      const issuer = intermediateCase ? forge.pki.createCertificate() : rootCert;
      if (intermediateCase) {
        issuer.publicKey = keys.publicKey;
        issuer.serialNumber = "1200";
        issuer.validity = rootCert.validity;
        issuer.setSubject([{ name: "commonName", value: "Malformed Intermediate" }]);
        issuer.setIssuer(rootCert.subject.attributes);
        issuer.setExtensions([
          { name: "basicConstraints", cA: true },
          { name: "keyUsage", keyCertSign: true },
          invalidExtension,
        ]);
        issuer.sign(rootKeys.privateKey, forge.md.sha256.create());
      }
      const leaf = forge.pki.createCertificate();
      leaf.publicKey = leafKeys.publicKey;
      leaf.serialNumber = (1100 + index).toString(16);
      leaf.validity = rootCert.validity;
      leaf.setSubject([{ name: "commonName", value: "127.0.0.1" }]);
      leaf.setIssuer(issuer.subject.attributes);
      leaf.setExtensions([
        { name: "basicConstraints", cA: false },
        { name: "subjectAltName", altNames: [{ type: 7, ip: "127.0.0.1" }] },
        ...(intermediateCase ? [] : [invalidExtension]),
      ]);
      leaf.sign(intermediateCase ? keys.privateKey : rootKeys.privateKey, forge.md.sha256.create());
      const pem = forge.pki.certificateToPem(leaf);
      const verify = createCustomCaCertificateVerifyProc(readCustomCaCertificatesFromPem(rootPem));
      const issuerCert = intermediateCase
        ? { data: forge.pki.certificateToPem(issuer), issuerCert: { data: rootPem } }
        : { data: rootPem };
      const code = await new Promise((resolve) =>
        verify(
          { hostname: "127.0.0.1", errorCode: -202, certificate: { data: pem, issuerCert } },
          resolve,
        ),
      );
      boundary["malformed-" + oid] = { policyCode: code };
    }
    // AKI 两种编码应等价；错误名称、序列号及签名不能借兼容处理绕过验证。
    await writeFile(caPath, rootPem);
    await applyDesktopChromiumNetworkPolicies(
      session,
      { httpProxyCaCertPath: caPath },
      policyLogger,
    );
    const checkCertificate = async (name, certificate, key) => {
      const server = createHttpsServer({ key, cert: certificate }, (_request, response) =>
        response.end("verified"),
      );
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      try {
        boundary[name] = {
          accepted:
            (await autoUpdater.httpExecutor.request({
              protocol: "https:",
              hostname: "127.0.0.1",
              port: server.address().port,
              path: "/",
            })) === "verified",
        };
      } catch {
        boundary[name] = { accepted: false };
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    };
    for (const [index, name] of [
      "aki-keyid",
      "aki-issuer-serial",
      "aki-wrong-serial",
      "aki-wrong-issuer",
      "aki-wrong-signature",
    ].entries()) {
      const leaf = forge.pki.createCertificate();
      leaf.publicKey = leafKeys.publicKey;
      leaf.serialNumber = (800 + index).toString(16);
      leaf.validity = rootCert.validity;
      leaf.setSubject([{ name: "commonName", value: "127.0.0.1" }]);
      leaf.setIssuer(rootCert.subject.attributes);
      leaf.setExtensions([
        { name: "basicConstraints", cA: false },
        { name: "subjectAltName", altNames: [{ type: 7, ip: "127.0.0.1" }] },
        { name: "extKeyUsage", serverAuth: true },
        name === "aki-keyid"
          ? {
              name: "authorityKeyIdentifier",
              keyIdentifier: rootCert.generateSubjectKeyIdentifier().getBytes(),
            }
          : {
              name: "authorityKeyIdentifier",
              authorityCertIssuer: name === "aki-wrong-issuer" ? leaf.subject : rootCert.issuer,
              serialNumber: name === "aki-wrong-serial" ? "ffff" : rootCert.serialNumber,
            },
      ]);
      leaf.sign(
        name === "aki-wrong-signature" ? keys.privateKey : rootKeys.privateKey,
        forge.md.sha256.create(),
      );
      await checkCertificate(
        name,
        forge.pki.certificateToPem(leaf) + rootPem,
        forge.pki.privateKeyToPem(leafKeys.privateKey),
      );
    }
    // forge 不签 RSA-PSS；只在测试夹具内由 OpenSSL 生成合成证书。
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const openssl = promisify(execFile);
    const keyPath = FIXTURE_DIR + "/pss-leaf.key";
    const rootKeyPath = FIXTURE_DIR + "/pss-root.key";
    const rootPath = FIXTURE_DIR + "/pss-root.pem";
    const csrPath = FIXTURE_DIR + "/pss-leaf.csr";
    const extensionPath = FIXTURE_DIR + "/pss.ext";
    await writeFile(keyPath, forge.pki.privateKeyToPem(leafKeys.privateKey));
    await writeFile(rootKeyPath, forge.pki.privateKeyToPem(rootKeys.privateKey));
    await writeFile(rootPath, rootPem);
    await writeFile(
      extensionPath,
      "subjectAltName=IP:127.0.0.1\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\nauthorityKeyIdentifier=none\n",
    );
    await openssl("openssl", [
      "req",
      "-new",
      "-key",
      keyPath,
      "-subj",
      "/CN=127.0.0.1",
      "-out",
      csrPath,
    ]);
    for (const [index, name] of ["pss-sha1", "pss-sha256", "pss-mgf1-sha1"].entries()) {
      const certPath = FIXTURE_DIR + "/" + name + ".pem";
      await openssl("openssl", [
        "x509",
        "-req",
        "-in",
        csrPath,
        "-CA",
        rootPath,
        "-CAkey",
        rootKeyPath,
        "-set_serial",
        String(900 + index),
        "-days",
        "1",
        "-extfile",
        extensionPath,
        name === "pss-sha1" ? "-sha1" : "-sha256",
        "-sigopt",
        "rsa_padding_mode:pss",
        "-sigopt",
        "rsa_mgf1_md:" + (name === "pss-sha256" ? "sha256" : "sha1"),
        "-out",
        certPath,
      ]);
      const certificate = await readFile(certPath, "utf8");
      const verify = createCustomCaCertificateVerifyProc(readCustomCaCertificatesFromPem(rootPem));
      const policyCode = await new Promise((resolve) =>
        verify(
          {
            hostname: "127.0.0.1",
            errorCode: -202,
            certificate: { data: certificate, issuerCert: { data: rootPem } },
          },
          resolve,
        ),
      );
      await checkCertificate(name, certificate + rootPem, await readFile(keyPath, "utf8"));
      boundary[name].policyCode = policyCode;
    }
    const circularCertificate = (subject, issuer, key, signer, serial) => {
      const value = forge.pki.createCertificate();
      value.publicKey = key.publicKey;
      value.serialNumber = serial;
      value.validity.notBefore = new Date(Date.now() - 86400000);
      value.validity.notAfter = new Date(Date.now() + 86400000);
      value.setSubject([{ name: "commonName", value: subject }]);
      value.setIssuer([{ name: "commonName", value: issuer }]);
      value.setExtensions([
        { name: "basicConstraints", cA: true },
        { name: "subjectAltName", altNames: [{ type: 7, ip: "127.0.0.1" }] },
      ]);
      value.sign(signer.privateKey, forge.md.sha256.create());
      return forge.pki.certificateToPem(value);
    };
    const circular = createHttpsServer(
      {
        key: forge.pki.privateKeyToPem(keys.privateKey),
        cert:
          circularCertificate("cycle-a", "cycle-b", keys, leafKeys, "701") +
          circularCertificate("cycle-b", "cycle-a", leafKeys, keys, "702"),
      },
      (_req, res) => res.end("must-not-accept"),
    );
    await new Promise((resolve) => circular.listen(0, "127.0.0.1", resolve));
    const cancellation = new CancellationToken();
    let timedOut = false;
    const deadline = setTimeout(() => {
      timedOut = true;
      cancellation.cancel();
    }, 5000);
    try {
      await autoUpdater.httpExecutor.request(
        { protocol: "https:", hostname: "127.0.0.1", port: circular.address().port, path: "/" },
        cancellation,
      );
      boundary.circular = { accepted: true, timedOut };
    } catch {
      boundary.circular = { accepted: false, timedOut };
    } finally {
      clearTimeout(deadline);
      await new Promise((resolve) => circular.close(resolve));
    }
    await applyDesktopChromiumNetworkPolicies(session, {}, policyLogger);
    const emptyProxyRoute = await updater.resolveProxy(
      "http://update-download.invalid/package.zip",
    );
    return {
      boundary,
      rejectedUntrusted,
      trusted,
      emptyProxyRoute,
      route,
      interrupted,
      requests,
      policyLogs,
      bypass,
      downloaded: (await readFile(destination)).length,
    };
  };
  const win = new BrowserWindow({ show: false });
  await win.loadURL("data:text/html,network fixture");
}

await build({
  stdin: {
    resolveDir: desktopDir,
    contents:
      "(" +
      runFixture.toString() +
      ")().catch(error => { console.error(error); process.exit(1); });",
  },
  define: { FIXTURE_DIR: JSON.stringify(artifactDir) },
  outfile: entry,
  bundle: true,
  platform: "node",
  format: "esm",
  external: ["electron", "electron-updater", "node-forge", "pkijs"],
  plugins: [
    {
      name: "network-only-browser-partition",
      setup(api) {
        api.onResolve({ filter: /^\.\/browserDataManager\.js$/ }, () => ({
          path: "partition",
          namespace: "fixture",
        }));
        api.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
          contents: 'export const EMBEDDED_BROWSER_PARTITION = "persist:embedded-browser";',
        }));
      },
    },
  ],
});
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
let electronApp;
let output = "";
try {
  electronApp = await _electron.launch({ executablePath: require("electron"), args: [entry], env });
  for (const stream of [electronApp.process().stdout, electronApp.process().stderr]) {
    stream?.on("data", (chunk) => {
      output += chunk.toString();
    });
  }
  await electronApp.firstWindow();
  const route = await electronApp.evaluate(() => globalThis.fixtureRoute);
  assert.match(route, /^PROXY 127\.0\.0\.1:/, "更新器遗漏设置页代理，测试域名将错误直连");
  const result = await electronApp.evaluate(() => globalThis.runDownload());
  assert.equal(result.interrupted, true);
  assert.equal(result.rejectedUntrusted, true);
  assert.equal(result.trusted, "trusted");
  assert.equal(result.boundary.circular.accepted, false);
  assert.equal(result.boundary.circular.timedOut, false);
  await writeFile(resolve(artifactDir, "result.json"), JSON.stringify(result, null, 2));
  for (const name of [
    "critical-unknown",
    "critical-unsupported",
    "usage-crl-only",
    "usage-key-encipherment-only",
    "usage-key-agreement-only",
  ]) {
    assert.equal(result.boundary[name].policyCode, -3, name + " policy");
    assert.equal(result.boundary[name].accepted, false, name + " HTTPS");
  }
  for (const name of [
    "noncritical-unknown",
    "usage-digital-signature",
    "usage-signature-and-encipherment",
    "usage-absent",
  ]) {
    assert.equal(result.boundary[name].policyCode, 0, name + " policy");
    assert.equal(result.boundary[name].accepted, true, name + " HTTPS");
  }
  for (const oid of ["2.5.29.15", "2.5.29.30", "2.5.29.32", "2.5.29.30-ca"])
    assert.equal(result.boundary["malformed-" + oid].policyCode, -3, oid + " malformed critical");
  assert.equal(result.boundary["pss-sha1"].policyCode, -3, "PSS SHA1 policy");
  assert.equal(result.boundary["pss-mgf1-sha1"].policyCode, -3, "PSS MGF1 SHA1 policy");
  assert.equal(result.boundary["pss-sha256"].policyCode, 0, "PSS SHA256 policy");
  for (const name of ["aki-keyid", "aki-issuer-serial", "pss-sha256"])
    assert.equal(result.boundary[name].accepted, true, name);
  for (const name of [
    "aki-wrong-serial",
    "aki-wrong-issuer",
    "aki-wrong-signature",
    "pss-sha1",
    "pss-mgf1-sha1",
  ])
    assert.equal(result.boundary[name].accepted, false, name);
  assert.equal(result.boundary["valid-root"].accepted, true);
  assert.equal(result.boundary["valid-intermediate"].accepted, true);
  assert.equal(result.boundary["aki-intermediate-serial"].accepted, true);
  for (const name of [
    "nonca-intermediate",
    "pathlen-blocked",
    "wrong-host",
    "expired",
    "not-yet-valid",
    "wrong-signature",
    "client-only",
    "sha1-signed",
    "rsa-1024",
  ])
    assert.equal(result.boundary[name].accepted, false, name);
  assert.equal(result.emptyProxyRoute, "DIRECT");
  assert.equal(result.downloaded, 256 * 1024);
  assert.equal(result.bypass, "bypassed");
  for (const name of ["default-session", "auto-updater", "embedded-browser"]) {
    assert.ok(
      result.policyLogs.some((message) =>
        message.startsWith(`[desktop-network] ${name} proxy mode=`),
      ),
      `network policy log is missing Session name: ${name}`,
    );
  }
  assert.deepEqual(result.requests, [
    "http://update-download.invalid/interrupted.zip",
    "http://update-download.invalid/package.zip",
  ]);
  assert.equal((await readFile(resolve(artifactDir, "package.zip"))).length, result.downloaded);
  await writeFile(resolve(artifactDir, "result.json"), JSON.stringify(result, null, 2));
  console.log("auto-update network smoke: PASS", artifactDir);
} finally {
  await writeFile(resolve(artifactDir, "electron.log"), output);
  await electronApp?.close().catch(() => {});
}
