import type { PrismaClient } from "../generated/prisma/client.js";
import { AssetProcessingStatus } from "../generated/prisma/enums.js";
import { CommunicationAssetResolver, type CommunicationAssetDelivery } from "./communication-assets.js";

const TERMINAL = new Set<AssetProcessingStatus>([
  AssetProcessingStatus.READY,
  AssetProcessingStatus.FAILED,
  AssetProcessingStatus.REJECTED_TOO_LARGE,
  AssetProcessingStatus.REJECTED_UNSUPPORTED,
]);

export interface CommunicationAssetStatusStore {
  statuses(deliveryId: string): Promise<AssetProcessingStatus[]>;
}

export class PrismaCommunicationAssetStatusStore implements CommunicationAssetStatusStore {
  constructor(private readonly prisma: PrismaClient) {}
  async statuses(deliveryId: string): Promise<AssetProcessingStatus[]> {
    const assets = await this.prisma.communicationAsset.findMany({
      where: { deliveryId },
      select: { storedFile: { select: { processingStatus: true } } },
    });
    return assets.map((asset) => asset.storedFile.processingStatus);
  }
}

export interface CommunicationAssetPreflight {
  prepare(delivery: CommunicationAssetDelivery): Promise<void>;
}

export class BoundedCommunicationAssetPreflight implements CommunicationAssetPreflight {
  constructor(
    private readonly resolver: CommunicationAssetResolver,
    private readonly store: CommunicationAssetStatusStore,
    private readonly timeoutMs: number,
    private readonly options: {
      now?: () => number;
      sleep?: (milliseconds: number) => Promise<void>;
      log?: (message: string) => void;
    } = {},
  ) {}

  async prepare(delivery: CommunicationAssetDelivery): Promise<void> {
    try {
      await this.resolver.resolve(delivery);
    } catch {
      this.options.log?.(
        `COMMUNICATION_ASSET_FAILED deliveryId=${delivery.id} status=FAILED errorCode=ASSET_DISCOVERY_ERROR`,
      );
      return;
    }
    const now = this.options.now ?? Date.now;
    const sleep = this.options.sleep ?? ((milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)));
    const deadline = now() + this.timeoutMs;
    while (true) {
      const statuses = await this.store.statuses(delivery.id);
      if (statuses.every((status) => TERMINAL.has(status))) return;
      const remaining = deadline - now();
      if (remaining <= 0) {
        this.options.log?.(
          `COMMUNICATION_ASSET_FAILED deliveryId=${delivery.id} status=TIMEOUT errorCode=ASSET_PREP_TIMEOUT`,
        );
        return;
      }
      await sleep(Math.min(1_000, remaining));
    }
  }
}
