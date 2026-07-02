import { findFirstByTypeCandidate, typedCollection, type TypedCollectionFacade } from "./kit";
import type { StorageCollection } from "../collections";
import type { CatalogDocument, CatalogItemDocument } from "../../types/documents";
import type { PriceDefinition, SellableDefinition } from "../../types/aggregates";
import type { ContentRef, MikaId } from "../../types/primitives";

/** Catalog item, sellable, and price tuple resolved from provider price lookup. */
export interface CatalogProviderPriceMatch {
  readonly catalog: CatalogItemDocument;
  readonly sellable: SellableDefinition;
  readonly price: PriceDefinition;
}

/** Document repository for catalog item and coupon lookup by content and provider refs. */
export class CatalogRepository {
  private readonly documents: TypedCollectionFacade<CatalogDocument>;

  constructor(collection: StorageCollection<CatalogDocument>) {
    this.documents = typedCollection(collection);
  }

  async findItemByContent(content: ContentRef): Promise<CatalogItemDocument | null> {
    return this.documents.findOneByType("catalogItem", {
      contentCollection: content.collection,
      contentId: content.id,
    });
  }

  async findItemBySellableId(sellableId: MikaId): Promise<CatalogItemDocument | null> {
    return findFirstByTypeCandidate(this.documents, "catalogItem", (item) =>
      item.data.aggregate.sellables.some((sellable) => sellable.id === sellableId)
        ? item.data
        : null,
    );
  }

  async findItemByProviderPrice(
    provider: string,
    providerPriceId: string,
  ): Promise<CatalogProviderPriceMatch | null> {
    return findFirstByTypeCandidate(this.documents, "catalogItem", (item) => {
      for (const sellable of item.data.aggregate.sellables) {
        const price = sellable.prices.find((candidate) =>
          candidate.providerRefs.some(
            (ref) => ref.provider === provider && ref.priceId === providerPriceId,
          ),
        );
        if (price) {
          return { catalog: item.data, sellable, price };
        }
      }

      return null;
    });
  }

  async findPriceById(priceId: MikaId): Promise<CatalogProviderPriceMatch | null> {
    return findFirstByTypeCandidate(this.documents, "catalogItem", (item) => {
      for (const sellable of item.data.aggregate.sellables) {
        const price = sellable.prices.find((candidate) => candidate.id === priceId);
        if (price) {
          return { catalog: item.data, sellable, price };
        }
      }

      return null;
    });
  }

  async put(document: CatalogDocument): Promise<void> {
    await this.documents.put(document);
  }
}
