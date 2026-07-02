import {
  findFirstByTypeCandidate,
  listAllByType,
  typedCollection,
  type DocumentList,
  type TypedCollectionFacade,
} from "./kit";
import type { StorageCollection } from "../collections";
import type { LedgerDocument, OrderDocument } from "../../types/documents";
import type { ISODateTime, MikaId } from "../../types/primitives";

/** Document repository for order ledger documents and provider payment lookup. */
export class LedgerRepository {
  private readonly documents: TypedCollectionFacade<LedgerDocument>;

  constructor(collection: StorageCollection<LedgerDocument>) {
    this.documents = typedCollection(collection);
  }

  async findOrderById(orderId: MikaId): Promise<OrderDocument | null> {
    return this.documents.findByIdOfType(orderId, "order");
  }

  async findOrderByNumber(orderNumber: string): Promise<OrderDocument | null> {
    return this.documents.findOneByType("order", { orderNumber });
  }

  async findOrderByProviderPayment(
    provider: string,
    providerPaymentId: string,
  ): Promise<OrderDocument | null> {
    return this.documents.findOneByType("order", {
      provider,
      providerPaymentId,
    });
  }

  async findOrderByProviderCheckout(
    provider: string,
    providerCheckoutId: string,
  ): Promise<OrderDocument | null> {
    return this.documents.findOneByType("order", {
      provider,
      providerCheckoutId,
    });
  }

  async findOrderByProviderOrder(
    provider: string,
    providerOrderId: string,
  ): Promise<OrderDocument | null> {
    return this.documents.findOneByType("order", {
      provider,
      providerOrderId,
    });
  }

  async findOrderByCheckoutSession(checkoutSessionId: MikaId): Promise<OrderDocument | null> {
    return this.documents.findOneByType("order", { checkoutSessionId });
  }

  async findOrderByDownloadRef(downloadRef: string): Promise<OrderDocument | null> {
    return findFirstByTypeCandidate(this.documents, "order", (item) =>
      item.data.aggregate.lines.some((line) => line.downloadRefs?.includes(downloadRef))
        ? item.data
        : null,
    );
  }

  async listOrdersByCustomer(customerId: MikaId, limit = 50): Promise<DocumentList<OrderDocument>> {
    return this.documents.listByType("order", {
      where: { customerId },
      orderBy: { createdAt: "desc" },
      limit,
    });
  }

  async listOrdersByEmailHash(emailHash: string, limit = 50): Promise<DocumentList<OrderDocument>> {
    return this.documents.listByType("order", {
      where: { emailHash },
      orderBy: { createdAt: "desc" },
      limit,
    });
  }

  async anonymizeOrdersForAccountDelete(input: {
    readonly customerId?: MikaId;
    readonly emailHash?: string;
    readonly sentinel: string;
    readonly now: ISODateTime;
  }): Promise<{ readonly anonymized: number }> {
    const byId = new Map<MikaId, OrderDocument>();
    if (input.customerId) {
      for (const item of await listAllByType(this.documents, "order", {
        where: { customerId: input.customerId },
        orderBy: { createdAt: "desc" },
      })) {
        byId.set(item.data.id, item.data);
      }
    }
    if (input.emailHash) {
      for (const item of await listAllByType(this.documents, "order", {
        where: { emailHash: input.emailHash },
        orderBy: { createdAt: "desc" },
      })) {
        byId.set(item.data.id, item.data);
      }
    }

    let anonymized = 0;
    for (const order of byId.values()) {
      const redacted: OrderDocument = {
        ...order,
        emailHash: input.sentinel,
        aggregate: {
          ...order.aggregate,
          customer: {
            ...order.aggregate.customer,
            email: undefined,
            emailHash: input.sentinel,
            name: undefined,
            company: undefined,
            vatId: undefined,
          },
        },
        updatedAt: input.now,
      };
      await this.put(redacted);
      anonymized += 1;
    }

    return { anonymized };
  }

  async put(document: LedgerDocument): Promise<void> {
    await this.documents.put(document);
  }
}
