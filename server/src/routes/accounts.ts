import { Router } from "express";
import {
  ANALYTICS_PLATFORMS,
  LOGIN_RUNNERS,
  accountLoggedIn,
  accountWhoami,
  clearWhoamiCache,
  loginStatus,
  logoutAccount,
  mpLoginStatus,
  runAnalytics,
  smsCode,
  startLogin,
  startMpLogin,
  wechatSaveCredentials,
  wechatVerifyToken,
  wechatWebAccount,
  writeLoginMarker,
  writeLoginSms,
} from "../domain.js";
import { asyncRoute, fail, param } from "../http.js";

export function accountsRouter(): Router {
  const router = Router();
  const analyticsInflight = new Map<string, Promise<Record<string, unknown>>>();

  router.get("/accounts", asyncRoute(async (_req, res) => {
    res.json(Object.entries(LOGIN_RUNNERS).map(([platform, config]) => ({
      platform,
      name: config.name,
      backend: config.backend,
      supported: config.backend !== "unsupported",
      loggedIn: accountLoggedIn(platform, config),
      note: config.note ?? "",
    })));
  }));

  router.post("/login/:platform", asyncRoute(async (req, res) => {
    const platform = param(req, "platform");
    if (!LOGIN_RUNNERS[platform]) fail("未知平台", 404);
    clearWhoamiCache(platform);
    res.json(await startLogin(platform, String(req.query.restart ?? "") === "true"));
  }));

  router.get("/login/:platform/status", asyncRoute(async (req, res) => {
    const platform = param(req, "platform");
    if (!LOGIN_RUNNERS[platform]) fail("未知平台", 404);
    const status = loginStatus(platform);
    if (status.state === "success") clearWhoamiCache(platform);
    res.json({ mode: "qr", ...status });
  }));

  router.post("/login/:platform/sms", asyncRoute(async (req, res) => {
    const platform = param(req, "platform");
    if (!LOGIN_RUNNERS[platform]) fail("未知平台", 404);
    const code = smsCode(String((req.body ?? {}).code ?? ""));
    if (!code) fail("验证码应为 4-8 位数字");
    writeLoginSms(platform, code);
    res.json({ ok: true });
  }));

  router.get("/accounts/:platform/credentials", asyncRoute(async (req, res) => {
    const platform = param(req, "platform");
    const config = LOGIN_RUNNERS[platform];
    if (!config || config.backend !== "wechat-oa") fail("该平台不使用凭证登录", 404);
    const account = wechatWebAccount();
    const appId = String(account.app_id ?? "");
    res.json({
      configured: Boolean(appId && String(account.app_secret ?? "")),
      appIdMasked: appId.length > 10 ? `${appId.slice(0, 6)}***${appId.slice(-4)}` : appId ? "***" : "",
      name: String(account.name ?? ""),
      author: String(account.author ?? ""),
    });
  }));

  router.post("/accounts/:platform/credentials", asyncRoute(async (req, res) => {
    const platform = param(req, "platform");
    const config = LOGIN_RUNNERS[platform];
    if (!config || config.backend !== "wechat-oa") fail("该平台不使用凭证登录", 404);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const appId = String(body.appId ?? "").trim();
    const appSecret = String(body.appSecret ?? "").trim();
    if (!appId || !appSecret) fail("AppID 和 AppSecret 都不能为空");
    wechatSaveCredentials(appId, appSecret, String(body.name ?? "").trim(), String(body.author ?? "").trim());
    const verified = await wechatVerifyToken();
    clearWhoamiCache(platform);
    if (verified.ok) {
      writeLoginMarker(platform, "success", String(body.name ?? "").trim() || "微信公众号");
      res.json({ ok: true, message: "公众号凭证已保存并验证通过" });
      return;
    }
    res.json({
      ok: false,
      message: `凭证已保存但验证未通过：${verified.message}。若是 40164 请把服务器出口 IP 加入公众号 IP 白名单。`,
    });
  }));

  router.post("/accounts/:platform/mp-login", asyncRoute(async (req, res) => {
    const config = LOGIN_RUNNERS[param(req, "platform")];
    if (!config || config.backend !== "wechat-oa") fail("该平台不使用公众号后台登录", 404);
    clearWhoamiCache("wechat-oa");
    res.json({ mode: "qr", ...(await startMpLogin()) });
  }));

  router.get("/accounts/:platform/mp-login/status", asyncRoute(async (req, res) => {
    const config = LOGIN_RUNNERS[param(req, "platform")];
    if (!config || config.backend !== "wechat-oa") fail("该平台不使用公众号后台登录", 404);
    res.json({ mode: "qr", ...mpLoginStatus() });
  }));

  router.get("/accounts/:platform/whoami", asyncRoute(async (req, res) => {
    const platform = param(req, "platform");
    if (!LOGIN_RUNNERS[platform]) fail("未知平台", 404);
    res.json(await accountWhoami(platform, String(req.query.force ?? "") === "true"));
  }));

  router.post("/logout/:platform", asyncRoute(async (req, res) => {
    const platform = param(req, "platform");
    if (!LOGIN_RUNNERS[platform]) fail("未知平台", 404);
    clearWhoamiCache(platform);
    res.json(await logoutAccount(platform));
  }));

  router.get("/analytics/platforms", asyncRoute(async (_req, res) => {
    res.json(Object.entries(LOGIN_RUNNERS)
      .filter(([platform]) => ANALYTICS_PLATFORMS.has(platform))
      .map(([platform, config]) => ({
        platform,
        name: config.name,
        loggedIn: accountLoggedIn(platform, config),
      })));
  }));

  router.get("/analytics/:platform", asyncRoute(async (req, res) => {
    const platform = param(req, "platform");
    if (!ANALYTICS_PLATFORMS.has(platform)) fail("该平台暂不支持数据抓取", 404);
    let task = analyticsInflight.get(platform);
    if (!task) {
      task = runAnalytics(platform).finally(() => analyticsInflight.delete(platform));
      analyticsInflight.set(platform, task);
    }
    res.json(await task);
  }));

  return router;
}
