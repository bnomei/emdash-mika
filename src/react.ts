/**
 * React context provider and hooks that expose the browser MikaClient for catalog and stock
 * queries inside client components.
 */
import { createContext, createElement, useContext, useMemo, type ReactNode } from "react";
import { createMikaClient, type MikaClient, type MikaClientOptions } from "./api/client";

/** Props for the root React provider; supply a client or options to create one. */
export interface MikaProviderProps {
  readonly client?: MikaClient;
  readonly options?: MikaClientOptions;
  readonly children?: ReactNode;
}

const MikaContext = createContext<MikaClient | null>(null);

/** Provides a `MikaClient` instance to descendant hooks via React context. */
export function MikaProvider({ client, options, children }: MikaProviderProps) {
  const value = useMemo(() => client ?? createMikaClient(options), [client, options]);

  return createElement(MikaContext.Provider, { value }, children);
}

/** Returns the `MikaClient` from the nearest `MikaProvider`; throws if missing. */
export function useMika(): MikaClient {
  const client = useContext(MikaContext);
  if (!client) {
    throw new Error("useMika() must be used inside <MikaProvider>.");
  }
  return client;
}

/** Convenience hook bound to `client.catalog.sellables`. */
export function useMikaSellables(): MikaClient["catalog"]["sellables"] {
  const catalog = useMika().catalog;
  return (...args) => catalog.sellables(...args);
}

/** Convenience hook bound to `client.stock.availability`. */
export function useMikaStock(): MikaClient["stock"]["availability"] {
  const stock = useMika().stock;
  return (...args) => stock.availability(...args);
}
