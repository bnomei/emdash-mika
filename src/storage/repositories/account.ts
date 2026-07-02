import {
  listAllByType,
  typedCollection,
  type DocumentList,
  type TypedCollectionFacade,
} from "./kit";
import { mirrorRecordFields } from "./record-mirror";
import type { StorageCollection } from "../collections";
import type {
  AccountDocument,
  CustomerDocument,
  EntitlementDocument,
  LicenseDocument,
  ProviderAccountDocument,
  SubscriptionDocument,
} from "../../types/documents";
import type { ISODateTime, MikaId } from "../../types/primitives";

/** Document repository for customer, entitlement, license, and subscription documents. */
export class AccountRepository {
  private readonly documents: TypedCollectionFacade<AccountDocument>;

  constructor(collection: StorageCollection<AccountDocument>) {
    this.documents = typedCollection(collection);
  }

  async findCustomerById(customerId: MikaId): Promise<CustomerDocument | null> {
    return this.documents.findOneByType("customer", { customerId });
  }

  async findCustomerByUserId(userId: string): Promise<CustomerDocument | null> {
    return this.documents.findOneByType("customer", { userId });
  }

  async findCustomerByEmailHash(emailHash: string): Promise<CustomerDocument | null> {
    return this.documents.findOneByType("customer", { emailHash });
  }

  async findEntitlementById(entitlementId: MikaId): Promise<EntitlementDocument | null> {
    return this.documents.findByIdOfType(entitlementId, "entitlement");
  }

  async findLicenseById(licenseId: MikaId): Promise<LicenseDocument | null> {
    return this.documents.findByIdOfType(licenseId, "license");
  }

  async findProviderAccount(
    provider: string,
    providerCustomerId: string,
  ): Promise<ProviderAccountDocument | null> {
    return this.documents.findOneByType("providerAccount", {
      provider,
      providerCustomerId,
    });
  }

  async findSubscriptionByProvider(
    provider: string,
    providerSubscriptionId: string,
  ): Promise<SubscriptionDocument | null> {
    return this.documents.findOneByType("subscription", {
      provider,
      providerSubscriptionId,
    });
  }

  async findSubscriptionById(subscriptionId: MikaId): Promise<SubscriptionDocument | null> {
    return this.documents.findByIdOfType(subscriptionId, "subscription");
  }

  async listProviderAccountsByCustomer(
    customerId: MikaId,
    limit = 50,
  ): Promise<DocumentList<ProviderAccountDocument>> {
    return this.documents.listByType("providerAccount", {
      where: { customerId },
      orderBy: { updatedAt: "desc" },
      limit,
    });
  }

  async listSubscriptionsByCustomer(
    customerId: MikaId,
    limit = 50,
  ): Promise<DocumentList<SubscriptionDocument>> {
    return this.documents.listByType("subscription", {
      where: { customerId },
      orderBy: { currentPeriodEnd: "desc" },
      limit,
    });
  }

  async listEntitlementsByCustomer(
    customerId: MikaId,
    limit = 100,
  ): Promise<DocumentList<EntitlementDocument>> {
    return this.documents.listByType("entitlement", {
      where: { customerId },
      orderBy: { updatedAt: "desc" },
      limit,
    });
  }

  async listEntitlementsByUser(
    userId: string,
    limit = 100,
  ): Promise<DocumentList<EntitlementDocument>> {
    return this.documents.listByType("entitlement", {
      where: { userId },
      orderBy: { updatedAt: "desc" },
      limit,
    });
  }

  async listEntitlementsByEmailHash(
    emailHash: string,
    limit = 100,
  ): Promise<DocumentList<EntitlementDocument>> {
    return this.documents.listByType("entitlement", {
      where: { emailHash },
      orderBy: { updatedAt: "desc" },
      limit,
    });
  }

  async listLicensesByCustomer(
    customerId: MikaId,
    limit = 100,
  ): Promise<DocumentList<LicenseDocument>> {
    return this.documents.listByType("license", {
      where: { customerId },
      orderBy: { updatedAt: "desc" },
      limit,
    });
  }

  async put(document: AccountDocument): Promise<void> {
    await this.documents.put(document);
  }

  async anonymizeCustomerForAccountDelete(input: {
    readonly customerId?: MikaId;
    readonly emailHash?: string;
    readonly now: ISODateTime;
  }): Promise<{ readonly anonymized: boolean; readonly sentinel?: string }> {
    const customer =
      (input.customerId ? await this.findCustomerById(input.customerId) : null) ??
      (input.emailHash ? await this.findCustomerByEmailHash(input.emailHash) : null);
    if (!customer) return { anonymized: false };

    const sentinel = `account-deleted:${customer.customerId}`;
    const anonymized: CustomerDocument = {
      ...customer,
      emailHash: sentinel,
      userId: sentinel,
      aggregate: {
        ...customer.aggregate,
        email: undefined,
        emailHash: sentinel,
        name: undefined,
        company: undefined,
        vatId: undefined,
        metadata: {
          ...customer.aggregate.metadata,
          anonymizedAt: input.now,
        },
      },
      updatedAt: input.now,
    };

    await this.put(anonymized);

    return { anonymized: true, sentinel };
  }

  async anonymizeEntitlementsForAccountDelete(input: {
    readonly customerId?: MikaId;
    readonly emailHash?: string;
    readonly userId?: string;
    readonly sentinel: string;
    readonly now: ISODateTime;
  }): Promise<{ readonly anonymized: number }> {
    const byId = new Map<MikaId, EntitlementDocument>();
    if (input.customerId) {
      for (const item of await listAllByType(this.documents, "entitlement", {
        where: { customerId: input.customerId },
        orderBy: { updatedAt: "desc" },
      })) {
        byId.set(item.data.id, item.data);
      }
    }
    if (input.emailHash) {
      for (const item of await listAllByType(this.documents, "entitlement", {
        where: { emailHash: input.emailHash },
        orderBy: { updatedAt: "desc" },
      })) {
        byId.set(item.data.id, item.data);
      }
    }
    if (input.userId) {
      for (const item of await listAllByType(this.documents, "entitlement", {
        where: { userId: input.userId },
        orderBy: { updatedAt: "desc" },
      })) {
        byId.set(item.data.id, item.data);
      }
    }

    let anonymized = 0;
    for (const entitlement of byId.values()) {
      const redacted = mirrorRecordFields(
        entitlement,
        input.now,
        { emailHash: input.sentinel, userId: input.sentinel },
        ["emailHash", "userId"],
      );
      await this.put(redacted);
      anonymized += 1;
    }

    return { anonymized };
  }

  async anonymizeLicensesForAccountDelete(input: {
    readonly customerId?: MikaId;
    readonly sentinel: string;
    readonly now: ISODateTime;
  }): Promise<{ readonly anonymized: number }> {
    const licenses = input.customerId
      ? await listAllByType(this.documents, "license", {
          where: { customerId: input.customerId },
          orderBy: { updatedAt: "desc" },
        })
      : [];

    let anonymized = 0;
    for (const item of licenses) {
      const license = item.data;
      const redacted: LicenseDocument = {
        ...mirrorRecordFields(
          license,
          input.now,
          {
            licenseKeyHash: `${input.sentinel}:license-redacted`,
            displayKeySuffix: "redacted",
            status: "revoked",
            revokedAt: license.record.revokedAt ?? input.now,
            metadata: {
              ...license.record.metadata,
              anonymizedAt: input.now,
            },
          },
          ["status"],
        ),
        customerId: undefined,
      };
      await this.put(redacted);
      anonymized += 1;
    }

    return { anonymized };
  }
}
