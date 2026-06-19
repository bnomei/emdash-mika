import { createContext, createElement, useContext, useMemo, type ReactNode } from "react";
import { createMikaClient, type MikaClient, type MikaClientOptions } from "./api/client";

export interface MikaProviderProps {
  readonly client?: MikaClient;
  readonly options?: MikaClientOptions;
  readonly children?: ReactNode;
}

const MikaContext = createContext<MikaClient | null>(null);

export function MikaProvider({ client, options, children }: MikaProviderProps) {
  const value = useMemo(() => client ?? createMikaClient(options), [client, options]);

  return createElement(MikaContext.Provider, { value }, children);
}

export function useMika(): MikaClient {
  const client = useContext(MikaContext);
  if (!client) {
    throw new Error("useMika() must be used inside <MikaProvider>.");
  }
  return client;
}

export function useMikaSellables(): MikaClient["catalog"]["sellables"] {
  const catalog = useMika().catalog;
  return (...args) => catalog.sellables(...args);
}

export function useMikaStock(): MikaClient["stock"]["availability"] {
  const stock = useMika().stock;
  return (...args) => stock.availability(...args);
}
