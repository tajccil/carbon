import type { Database } from "@carbon/database";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@supabase/supabase-js";
import type { MutableRefObject } from "react";
import type { StoreApi } from "zustand";
import { getSupabaseClientUrl, SUPABASE_ANON_KEY } from "../../config/env";

export const getCarbonClient = (
  supabaseKey: string,
  accessToken?: string
): SupabaseClient<Database, "public"> => {
  const global = accessToken
    ? {
        global: {
          headers: {
            Authorization: `Bearer ${accessToken}`
          }
        }
      }
    : {};

  const client = createClient<Database, "public">(
    getSupabaseClientUrl(),
    supabaseKey,
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false
      },
      ...global
    }
  );

  return client;
};

export const getCarbonAPIKeyClient = (apiKey: string) => {
  const client = createClient<Database, "public">(
    getSupabaseClientUrl(),
    SUPABASE_ANON_KEY!,
    {
      global: {
        headers: {
          "carbon-key": apiKey
        }
      }
    }
  );

  return client;
};

export const createCarbonWithAuthGetter = (
  store: MutableRefObject<StoreApi<{ accessToken: string }>>
) => {
  return createClient<Database, "public">(
    getSupabaseClientUrl(),
    SUPABASE_ANON_KEY!,
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false
      },
      async accessToken() {
        if (!store.current) return null;
        const state = store.current.getState();
        return state.accessToken;
      }
    }
  );
};

export const getCarbon = (accessToken?: string) => {
  return getCarbonClient(SUPABASE_ANON_KEY!, accessToken);
};

export const carbonClient = getCarbon();
