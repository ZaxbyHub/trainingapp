import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getDeviceMemory,
  getMemoryBudget,
  selectModelTier,
  getMemoryPressureStatus,
  formatMemoryIndicator,
  MemoryBudget,
  MemoryPressureStatus,
} from './memory-aware';

// Mock navigator global
const mockNavigator = {
  deviceMemory: undefined as number | undefined,
  userAgent: '',
};

vi.stubGlobal('navigator', mockNavigator);

describe('memory-aware', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockNavigator.deviceMemory = undefined;
    mockNavigator.userAgent = '';
  });

  describe('getDeviceMemory', () => {
    test('returns navigator.deviceMemory when available', () => {
      mockNavigator.deviceMemory = 8;
      expect(getDeviceMemory()).toBe(8);
    });

    test('returns 8 (high-capacity) when deviceMemory is undefined so the memory gate does not false-block wllama on unsupported browsers (issue #21 F4)', () => {
      mockNavigator.deviceMemory = undefined;
      expect(getDeviceMemory()).toBe(8);
    });

    test('returns 8 when deviceMemory is 0 (treated as unknown)', () => {
      mockNavigator.deviceMemory = 0;
      expect(getDeviceMemory()).toBe(8);
    });

    test('returns 8 when deviceMemory is negative (treated as unknown)', () => {
      mockNavigator.deviceMemory = -2;
      expect(getDeviceMemory()).toBe(8);
    });
  });

  describe('getMemoryBudget', () => {
    test('calculates availableMB correctly for Chrome with 8GB device', () => {
      mockNavigator.deviceMemory = 8;
      mockNavigator.userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0';

      const budget = getMemoryBudget();

      expect(budget.totalMB).toBe(8192);
      expect(budget.browserOverheadMB).toBe(0);
      expect(budget.availableMB).toBe(8192);
    });

    test('calculates availableMB correctly for Firefox with 8GB device', () => {
      mockNavigator.deviceMemory = 8;
      mockNavigator.userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:120.0) Gecko/20100101 Firefox/120.0';

      const budget = getMemoryBudget();

      expect(budget.totalMB).toBe(8192);
      expect(budget.browserOverheadMB).toBe(0);
      expect(budget.availableMB).toBe(8192);
    });

    test('calculates availableMB correctly for Safari with 4GB device', () => {
      mockNavigator.deviceMemory = 4;
      mockNavigator.userAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15';

      const budget = getMemoryBudget();

      expect(budget.totalMB).toBe(4096);
      expect(budget.browserOverheadMB).toBe(2048);
      expect(budget.availableMB).toBe(2048);
    });

    test('calculates availableMB with no deviceMemory (defaults to 8GB high-capacity, waives overhead — issue #21 F4 / #23 F12 graduated taper)', () => {
      mockNavigator.deviceMemory = undefined;
      mockNavigator.userAgent = 'Chrome/120.0.0.0';

      const budget = getMemoryBudget();

      // Unknown deviceMemory → getDeviceMemory() returns 8 (Chrome privacy cap,
      // per #21 F4). The graduated taper (#23 F12) then yields overhead 0 at
      // rawGD=8, so available = 8192 (consistent with #21's no-false-block intent).
      expect(budget.totalMB).toBe(8192);
      expect(budget.browserOverheadMB).toBe(0);
      expect(budget.availableMB).toBe(8192);
    });
  });

  describe('selectModelTier', () => {
    test('HIGH tier (>=8GB): rerankingEnabled=true, maxChunkCount=10000', () => {
      const config = selectModelTier(8192);

      expect(config.embeddingModel).toBe('bge-small-en-v1.5');
      expect(config.embeddingDimension).toBe(384);
      expect(config.rerankingEnabled).toBe(true);
      expect(config.maxChunkCount).toBe(10000);
    });

    test('HIGH tier with memory above 8GB', () => {
      const config = selectModelTier(12288);

      expect(config.rerankingEnabled).toBe(true);
      expect(config.maxChunkCount).toBe(10000);
    });

    test('MEDIUM tier (>=4GB, <8GB): rerankingEnabled=false, maxChunkCount=5000', () => {
      const config = selectModelTier(4096);

      expect(config.embeddingModel).toBe('bge-small-en-v1.5');
      expect(config.embeddingDimension).toBe(384);
      expect(config.rerankingEnabled).toBe(false);
      expect(config.maxChunkCount).toBe(5000);
    });

    test('MEDIUM tier with memory just above 4GB threshold', () => {
      const config = selectModelTier(4097);

      expect(config.rerankingEnabled).toBe(false);
      expect(config.maxChunkCount).toBe(5000);
    });

    test('LOW tier (<4GB): rerankingEnabled=false, maxChunkCount=1000', () => {
      const config = selectModelTier(2048);

      expect(config.embeddingModel).toBe('bge-small-en-v1.5');
      expect(config.embeddingDimension).toBe(384);
      expect(config.rerankingEnabled).toBe(false);
      expect(config.maxChunkCount).toBe(1000);
    });

    test('LOW tier with minimal memory (512MB)', () => {
      const config = selectModelTier(512);

      expect(config.rerankingEnabled).toBe(false);
      expect(config.maxChunkCount).toBe(1000);
    });

    test('LOW tier at boundary (just below 4GB)', () => {
      const config = selectModelTier(4095);

      expect(config.rerankingEnabled).toBe(false);
      expect(config.maxChunkCount).toBe(1000);
    });
  });

  describe('getMemoryPressureStatus', () => {
    beforeEach(() => {
      // Mock for HIGH tier (Chrome, 8GB device)
      mockNavigator.deviceMemory = 8;
      mockNavigator.userAgent = 'Chrome/120.0.0.0';
    });

    test('returns "normal" when availableMB >= 8192', () => {
      // With new privacy-cap waiver (isHighCapacity when rawGD >=8): overhead=0 for 8GB+ reported
      // So 16GB device: totalMB=16384, overhead=0, availableMB=16384 >=8192 -> 'normal'
      // (Previously without waiver, 16GB Chrome would have been 16384-2048=14336)

      mockNavigator.deviceMemory = 16; // 16GB device
      mockNavigator.userAgent = 'Chrome/120.0.0.0'; // >=8 -> overhead waived =0
      // availableMB = 16384 - 0 = 16384 >= 8192 -> 'normal'

      expect(getMemoryPressureStatus()).toBe('normal');
    });

    test('returns "moderate" when availableMB >= 4096 and < 8192', () => {
      // 7GB device, Chrome (F12 graduated overhead): total=7168,
      // taper=(8-7)/4=0.25 → overhead=512 → available=6656.
      // 6656 >= 4096 is TRUE, 6656 >= 8192 is FALSE -> 'moderate'
      mockNavigator.deviceMemory = 7;
      mockNavigator.userAgent = 'Chrome/120.0.0.0';

      expect(getMemoryPressureStatus()).toBe('moderate');
    });

    test('returns "critical" when availableMB < 4096', () => {
      mockNavigator.deviceMemory = 4;
      mockNavigator.userAgent = 'Chrome/120.0.0.0';
      // availableMB = 4096 - 2048 = 2048 < 4096 -> 'critical'

      expect(getMemoryPressureStatus()).toBe('critical');
    });

    test('F12/#21: unknown deviceMemory (Firefox/Safari) does NOT classify as "critical" (avoids false-blocking)', () => {
      // Combined fix: #21 F4 makes getDeviceMemory() return 8 (high-capacity)
      // for unknown, and #23 F12's graduated taper yields overhead 0 at rawGD=8.
      // Net: unknown hardware classifies as "normal", not "critical" — the core
      // goal of both findings (don't false-block Firefox/Safari/CPU-engine users).
      mockNavigator.deviceMemory = undefined;
      mockNavigator.userAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15';

      expect(getMemoryPressureStatus()).not.toBe('critical');
    });

    test('F12: graduated taper gives known mid-range hardware a proportionate (not full) overhead', () => {
      // The novel #23 F12 contribution: a KNOWN 6GB machine no longer pays the
      // full 2048MB overhead (the old binary cliff). taper=(8-6)/4=0.5 → 1024.
      mockNavigator.deviceMemory = 6;
      mockNavigator.userAgent = 'Chrome/120.0.0.0';

      const budget = getMemoryBudget();
      expect(budget.browserOverheadMB).toBe(1024); // graduated, not 2048
      expect(budget.availableMB).toBe(5120); // 6144 - 1024
    });
  });

  describe('formatMemoryIndicator', () => {
    test('produces readable text for "normal" status', () => {
      const budget: MemoryBudget = {
        totalMB: 16384,
        availableMB: 14336,
        browserOverheadMB: 2048,
      };

      const result = formatMemoryIndicator('normal', budget);

      expect(result).toBe('Memory: 14.0GB available — Full feature set enabled');
    });

    test('produces readable text for "moderate" status', () => {
      const budget: MemoryBudget = {
        totalMB: 8192,
        availableMB: 8192,
        browserOverheadMB: 0,
      };

      const result = formatMemoryIndicator('moderate', budget);

      expect(result).toBe('Memory: 8.0GB available — Reduced mode (reranking disabled)');
    });

    test('produces readable text for "critical" status', () => {
      const budget: MemoryBudget = {
        totalMB: 4096,
        availableMB: 2048,
        browserOverheadMB: 2048,
      };

      const result = formatMemoryIndicator('critical', budget);

      expect(result).toBe('Memory: 2.0GB available — Minimal mode (reduced chunk limit)');
    });

    test('handles fractional GB values correctly', () => {
      const budget: MemoryBudget = {
        totalMB: 8192,
        availableMB: 7168,
        browserOverheadMB: 1024,
      };

      const result = formatMemoryIndicator('normal', budget);

      expect(result).toBe('Memory: 7.0GB available — Full feature set enabled');
    });
  });

  describe('integration scenarios', () => {
    test('8GB Chrome device uses HIGH tier correctly', () => {
      mockNavigator.deviceMemory = 8;
      mockNavigator.userAgent = 'Chrome/120.0.0.0';

      const budget = getMemoryBudget();
      const status = getMemoryPressureStatus();
      const config = selectModelTier(budget.availableMB);

      // 8GB Chrome: availableMB = 8192 (overhead waived since >=8)
      expect(budget.availableMB).toBe(8192);
      // 8192 >= 8192 -> normal
      expect(status).toBe('normal');
      // 8192 >= 8192 -> HIGH tier
      expect(config.rerankingEnabled).toBe(true);
      expect(config.maxChunkCount).toBe(10000);
    });

    test('16GB Chrome device uses HIGH tier correctly', () => {
      mockNavigator.deviceMemory = 16;
      mockNavigator.userAgent = 'Chrome/120.0.0.0';

      const budget = getMemoryBudget();
      const status = getMemoryPressureStatus();
      const config = selectModelTier(budget.availableMB);

      // 16GB Chrome: availableMB = 16384 - 0 = 16384 (overhead waived)
      expect(budget.availableMB).toBe(16384);
      // 16384 >= 8192 -> normal
      expect(status).toBe('normal');
      // 16384 >= 8192 -> HIGH tier
      expect(config.rerankingEnabled).toBe(true);
      expect(config.maxChunkCount).toBe(10000);
    });

    test('2GB device uses LOW tier correctly', () => {
      mockNavigator.deviceMemory = 2;
      mockNavigator.userAgent = 'Chrome/120.0.0.0';

      const budget = getMemoryBudget();
      const status = getMemoryPressureStatus();
      const config = selectModelTier(budget.availableMB);

      // 2GB Chrome: availableMB = 2048 - 2048 = 0
      expect(budget.availableMB).toBe(0);
      // 0 >= 4096 -> FALSE -> critical
      expect(status).toBe('critical');
      // 0 < 4096 -> LOW tier
      expect(config.rerankingEnabled).toBe(false);
      expect(config.maxChunkCount).toBe(1000);
    });
  });
});
