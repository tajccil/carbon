import type { Database } from "@carbon/database";
import { checkApiKeyRateLimit } from "@carbon/database/ratelimit";
import type {
  AuthSession as SupabaseAuthSession,
  SupabaseClient
} from "@supabase/supabase-js";
import { createHash } from "crypto";
import { redirect } from "react-router";
import { REFRESH_ACCESS_TOKEN_THRESHOLD, VERCEL_URL } from "../config/env";
import { getCarbon } from "../lib/supabase";
import { getCarbonAPIKeyClient } from "../lib/supabase/client";
import { getCarbonServiceRole } from "../lib/supabase/client.server";
import type { AuthSession } from "../types";
import { path } from "../utils/path";
import { error } from "../utils/result";
import {
  destroyAuthSession,
  flash,
  requireAuthSession
} from "./session.server";
import { getCompaniesForUser } from "./users";
import { getUserClaims } from "./users.server";
import { sendLoginOtpEmail } from "./verification.server";

export async function createEmailAuthAccount(
  email: string,
  password: string,
  meta?: Record<string, unknown>
) {
  const { data, error } = await getCarbonServiceRole().auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    app_metadata: {
      ...meta
    }
  });

  if (!data.user || error) {
    console.error("[createEmailAuthAccount]", email, error?.message ?? error);
    return null;
  }

  return data.user;
}

export async function deleteAuthAccount(
  client: SupabaseClient<Database>,
  userId: string
) {
  const [supabaseDelete, carbonDelete] = await Promise.all([
    client.auth.admin.deleteUser(userId),
    client.from("user").delete().eq("id", userId)
  ]);

  if (supabaseDelete.error || carbonDelete.error) return null;

  return true;
}

export async function getAuthAccountByAccessToken(accessToken: string) {
  const { data, error } =
    await getCarbonServiceRole().auth.getUser(accessToken);

  if (!data.user || error) return null;

  return data.user;
}

/** Hash an API key using SHA-256 for secure storage/lookup */
export function hashApiKey(rawKey: string): string {
  return createHash("sha256").update(rawKey).digest("hex");
}

type ApiKeyRecord = {
  id: string;
  companyId: string;
  createdBy: string;
  scopes: Record<string, string[]>;
  rateLimit: number;
  rateLimitWindow: "1m" | "1h" | "1d";
  expiresAt: string | null;
};

function getCompanyIdFromAPIKey(apiKey: string) {
  const serviceRole = getCarbonServiceRole();
  const keyHash = hashApiKey(apiKey);
  return serviceRole
    .from("apiKey")
    .select(
      "id, companyId, createdBy, scopes, rateLimit, rateLimitWindow, expiresAt"
    )
    .eq("keyHash", keyHash)
    .single();
}

function makeAuthSession(
  supabaseSession: SupabaseAuthSession | null,
  companyId: string
): AuthSession | null {
  if (!supabaseSession) return null;

  if (!supabaseSession.refresh_token)
    throw new Error("User should have a refresh token");

  if (!supabaseSession.user?.email)
    throw new Error("User should have an email");

  return {
    accessToken: supabaseSession.access_token,
    companyId,
    refreshToken: supabaseSession.refresh_token,
    userId: supabaseSession.user.id,
    email: supabaseSession.user.email,
    expiresIn:
      (supabaseSession.expires_in ?? 3000) - REFRESH_ACCESS_TOKEN_THRESHOLD,
    expiresAt: supabaseSession.expires_at ?? -1
  };
}

export async function requirePermissions(
  request: Request,
  requiredPermissions: {
    view?: string | string[];
    create?: string | string[];
    update?: string | string[];
    delete?: string | string[];
    role?: string;
    bypassRls?: boolean;
  }
): Promise<{
  client: SupabaseClient<Database>;
  companyId: string;
  email: string;
  userId: string;
}> {
  const apiKey = request.headers.get("carbon-key");
  if (apiKey) {
    const company = await getCompanyIdFromAPIKey(apiKey);
    if (company.data) {
      const apiKeyData = company.data as unknown as ApiKeyRecord;
      const companyId = apiKeyData.companyId;
      const userId = apiKeyData.createdBy;

      // Check expiration
      if (apiKeyData.expiresAt && new Date(apiKeyData.expiresAt) < new Date()) {
        throw new Response("API key has expired", { status: 401 });
      }

      // Check rate limit via Postgres function
      const serviceRole = getCarbonServiceRole();
      const rl = await checkApiKeyRateLimit(
        serviceRole,
        apiKeyData.id,
        apiKeyData.rateLimit,
        apiKeyData.rateLimitWindow
      );
      if (!rl.success) {
        throw new Response("Rate limit exceeded", {
          status: 429,
          headers: {
            "Content-Type": "application/json",
            "X-RateLimit-Limit": rl.limit.toString(),
            "X-RateLimit-Remaining": rl.remaining.toString(),
            "X-RateLimit-Reset": rl.resetAt.toString(),
            "Retry-After": Math.ceil(
              (rl.resetAt - Date.now()) / 1000
            ).toString()
          }
        });
      }

      // Update lastUsedAt (fire-and-forget)
      // @ts-expect-error -- Supabase deep type instantiation on chained calls
      void serviceRole
        .from("apiKey")
        .update({ lastUsedAt: new Date().toISOString() } as any)
        .eq("id" as any, apiKeyData.id);

      // Check scopes against required permissions
      const scopes = apiKeyData.scopes ?? {};
      const scopeCheckPassed = Object.entries(requiredPermissions).every(
        ([action, permission]) => {
          if (action === "bypassRls" || action === "role") return true;
          if (typeof permission === "string") {
            const scopeKey = `${permission}_${action}`;
            return scopeKey in scopes && scopes[scopeKey]?.includes(companyId);
          } else if (Array.isArray(permission)) {
            return permission.every((p) => {
              const scopeKey = `${p}_${action}`;
              return (
                scopeKey in scopes && scopes[scopeKey]?.includes(companyId)
              );
            });
          }
          return false;
        }
      );

      if (!scopeCheckPassed) {
        throw new Response("API key lacks required permissions", {
          status: 403
        });
      }

      const client = getCarbonAPIKeyClient(apiKey);
      return {
        client,
        companyId,
        userId,
        email: ""
      };
    }
  }

  const { accessToken, companyId, email, userId } =
    await requireAuthSession(request);

  const myClaims = await getUserClaims(userId, companyId);

  // early exit if no requiredPermissions are required
  if (Object.keys(requiredPermissions).length === 0) {
    return {
      client:
        requiredPermissions.bypassRls && myClaims.role === "employee"
          ? getCarbonServiceRole()
          : getCarbon(accessToken),
      companyId,
      email,
      userId
    };
  }

  const hasRequiredPermissions = Object.entries(requiredPermissions).every(
    ([action, permission]) => {
      if (action === "bypassRls") return true;
      if (typeof permission === "string") {
        if (action === "role") {
          return myClaims.role === permission;
        }
        if (!(permission in myClaims.permissions)) return false;
        const permissionForCompany =
          myClaims.permissions[permission][
            action as "view" | "create" | "update" | "delete"
          ];
        return (
          permissionForCompany.includes("0") || // 0 is the wildcard for all companies
          permissionForCompany.includes(companyId)
        );
      } else if (Array.isArray(permission)) {
        return permission.every((p) => {
          const permissionForCompany =
            myClaims.permissions[p][
              action as "view" | "create" | "update" | "delete"
            ];
          return permissionForCompany.includes(companyId);
        });
      } else {
        return false;
      }
    }
  );

  if (!hasRequiredPermissions) {
    if (myClaims.role === null) {
      throw redirect("/", await destroyAuthSession(request));
    }
    throw redirect(
      path.to.authenticatedRoot,
      await flash(
        request,
        error({ myClaims: myClaims, requiredPermissions }, "Access Denied")
      )
    );
  }

  return {
    client:
      !!requiredPermissions.bypassRls && myClaims.role === "employee"
        ? getCarbonServiceRole()
        : getCarbon(accessToken),
    companyId,
    email,
    userId
  };
}

export async function resetPassword(accessToken: string, password: string) {
  const { error } = await getCarbon(accessToken).auth.updateUser({
    password
  });

  if (error) return null;

  return true;
}

export async function sendInviteByEmail(
  email: string,
  data?: Record<string, unknown>
) {
  return getCarbonServiceRole().auth.admin.inviteUserByEmail(email, {
    redirectTo: `${VERCEL_URL}`,
    data
  });
}

/**
 * Email sign-in OTP: Supabase generates the code; we deliver it with the same
 * SMTP/Resend path as signup verification emails. User completes sign-in via
 * `verifyLoginOtpAndCreateAuthSession`.
 */
export async function sendLoginOtp(email: string) {
  const { data, error } = await getCarbonServiceRole().auth.admin.generateLink({
    type: "magiclink",
    email,
    options: {
      redirectTo: `${VERCEL_URL}`
    }
  });

  if (error) {
    return { data: null, error };
  }

  const otp = data?.properties?.email_otp;
  if (!otp) {
    return {
      data: null,
      error: { message: "Sign-in code could not be generated" }
    };
  }

  const sent = await sendLoginOtpEmail(email, otp);

  if (!sent) {
    return {
      data: null,
      error: { message: "Failed to send sign-in code email" }
    };
  }

  return { data: { user: data.user }, error: null };
}

/** Completes passwordless email sign-in after the user enters the OTP from email. */
export async function verifyLoginOtpAndCreateAuthSession(
  email: string,
  token: string
): Promise<AuthSession | null> {
  const client = getCarbon();
  const { data, error } = await client.auth.verifyOtp({
    email,
    token,
    type: "magiclink"
  });

  if (error || !data.session) {
    console.error(
      "[verifyLoginOtpAndCreateAuthSession]",
      email,
      error?.message ?? error
    );
    return null;
  }

  const companyIds = await getCompaniesForUser(
    getCarbon(data.session.access_token),
    data.session.user.id
  );

  if (!companyIds.length) {
    console.error(
      "[verifyLoginOtpAndCreateAuthSession] no company for user",
      email
    );
    return null;
  }

  return makeAuthSession(data.session, companyIds[0]);
}

export async function signInWithEmail(email: string, password: string) {
  const client = getCarbonServiceRole();
  const { data, error } = await client.auth.signInWithPassword({
    email,
    password
  });

  if (!data.session || error) return null;
  const companies = await getCompaniesForUser(client, data.user.id);

  return makeAuthSession(data.session, companies?.[0]);
}

export async function refreshAccessToken(
  refreshToken?: string,
  companyId?: string
): Promise<AuthSession | null> {
  if (!refreshToken) return null;

  const client = getCarbonServiceRole();

  const { data, error } = await client.auth.refreshSession({
    refresh_token: refreshToken
  });

  if (!data.session || error) return null;

  return makeAuthSession(data.session, companyId!);
}

export async function verifyAuthSession(authSession: AuthSession) {
  const authAccount = await getAuthAccountByAccessToken(
    authSession.accessToken
  );

  return Boolean(authAccount);
}
