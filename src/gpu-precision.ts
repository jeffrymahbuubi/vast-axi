// Static per-GPU peak throughput table for `search --precision`.
//
// Keyed by the exact `gpu_name` string vast.ai returns in an offer (spaces
// included, for example "RTX 4090"). Researched 2026-10-20 from vendor
// datasheets and architecture whitepapers; the URL each entry was read from is
// in `source`. These are DENSE PEAK vendor numbers, NOT measured performance.
//
// Definitions (per GPU, TFLOPS):
//   fp32  non-tensor FP32 at boost clock.
//   tf32  TF32 tensor-core, dense (no sparsity); null when the GPU has no TF32
//         tensor cores (pre-Ampere) or the vendor does not publish it.
//   fp16  FP16/BF16 tensor-core, dense, FP32 accumulate (the ML training mode);
//         null when the GPU has no tensor cores. GeForce cards run FP32
//         accumulate at half the FP16-accumulate rate; the half-rate value is
//         the one stored here. The crippled non-tensor FP16 rate is never used.
//
// Where the vendor prints "with sparsity" figures only (Hopper, Blackwell
// data-center), the stored value is the printed figure halved (NVIDIA states
// dense = 1/2 sparse). Entries whose numbers are not printed verbatim in the
// source carry a `note` saying how they were derived. A vast gpu_name that can
// mean several SKUs uses the lower variant (see `note`).
//
// A GPU that is not listed here, or has a null for the asked precision, gets a
// null value in `search --precision` and sorts last.

export const PRECISIONS = ["fp32", "tf32", "fp16"] as const;
export type Precision = (typeof PRECISIONS)[number];

/** Date the table was researched, shown to the agent in `value_basis`. */
export const GPU_PRECISION_DATE = "2026-10-20";

export interface GpuPeak {
  fp32: number | null;
  tf32: number | null;
  fp16: number | null;
  /** Vendor URL the numbers were read from. */
  source: string;
  /** How a number was derived, or which variant a shared vast name means. */
  note?: string;
}

const WP_BLACKWELL =
  "https://images.nvidia.com/aem-dam/Solutions/geforce/blackwell/nvidia-rtx-blackwell-gpu-architecture.pdf";
const WP_PRO =
  "https://www.nvidia.com/content/dam/en-zz/Solutions/design-visualization/quadro-product-literature/pdf/NVIDIA-RTX-Blackwell-PRO-GPU-Architecture-v1_1.pdf";
const WP_ADA =
  "https://images.nvidia.com/aem-dam/Solutions/Data-Center/l4/nvidia-ada-gpu-architecture-whitepaper-v2.1.pdf";
const WP_AMPERE =
  "https://www.nvidia.com/content/PDF/nvidia-ampere-ga-102-gpu-architecture-whitepaper-v2.pdf";
const WP_TURING =
  "https://images.nvidia.com/aem-dam/en-zz/Solutions/design-visualization/technologies/turing-architecture/NVIDIA-Turing-Architecture-Whitepaper.pdf";
const DS_A100 =
  "https://www.nvidia.com/content/dam/en-zz/Solutions/Data-Center/a100/pdf/nvidia-a100-datasheet-us-nvidia-1758950-r4-web.pdf";
const DS_V100 =
  "https://images.nvidia.com/content/technologies/volta/pdf/volta-v100-datasheet-update-us-1165301-r5.pdf";
const DS_H100_PCIE =
  "https://www.megware.com/fileadmin/user_upload/LandingPage%20NVIDIA/nvidia-h100-datasheet.pdf";
const PAGE_H100 = "https://www.nvidia.com/en-us/data-center/h100/";
const PAGE_H200 = "https://www.nvidia.com/en-us/data-center/h200/";
const PAGE_HGX = "https://www.nvidia.com/en-us/data-center/b200";
const PAGE_5060 =
  "https://www.nvidia.com/en-us/geforce/graphics-cards/50-series/rtx-5060-family/";
const PAGE_4080 =
  "https://www.nvidia.com/en-us/geforce/graphics-cards/40-series/rtx-4080-family/";
const PAGE_4070 =
  "https://www.nvidia.com/en-us/geforce/graphics-cards/40-series/rtx-4070-family/";
const PAGE_4060 =
  "https://www.nvidia.com/en-us/geforce/graphics-cards/40-series/rtx-4060-4060ti/";
const PAGE_30 =
  "https://www.nvidia.com/en-us/geforce/graphics-cards/30-series/rtx-3060-3060ti";

const ADA_NOTE =
  "tf32 = AI TOPS / 16 and fp16 = AI TOPS / 8 (AI TOPS = FP8 sparse on the product page); the same ratios reproduce the Ada whitepaper values for RTX 4090/4080/4070 Ti/4070; fp32 set equal to tf32 as on every GeForce Ada card in the whitepaper";

export const GPU_PRECISION: Readonly<Record<string, GpuPeak>> = {
  // GeForce Blackwell
  "RTX 5090": { fp32: 104.8, tf32: 104.8, fp16: 209.5, source: WP_BLACKWELL },
  "RTX 5080": { fp32: 56.3, tf32: 56.3, fp16: 112.6, source: WP_BLACKWELL },
  "RTX 5070 Ti": { fp32: 43.9, tf32: 43.9, fp16: 87.9, source: WP_BLACKWELL },
  "RTX 5070": { fp32: 30.9, tf32: 30.9, fp16: 61.7, source: WP_BLACKWELL },
  "RTX 5060 Ti": {
    fp32: 23.7,
    tf32: 23.7,
    fp16: 47.4,
    source: PAGE_5060,
    note: "derived from the page's 759 AI TOPS (FP4 sparse): tf32 = AI TOPS / 32, fp16 = AI TOPS / 16; the same ratios reproduce the Blackwell whitepaper values for RTX 5090/5080/5070 Ti/5070",
  },
  "RTX 5060": {
    fp32: 19.2,
    tf32: 19.2,
    fp16: 38.4,
    source: PAGE_5060,
    note: "derived from the page's 614 AI TOPS (FP4 sparse): tf32 = AI TOPS / 32, fp16 = AI TOPS / 16; the same ratios reproduce the Blackwell whitepaper values for RTX 5090/5080/5070 Ti/5070",
  },

  // GeForce Ada
  "RTX 4090": { fp32: 82.6, tf32: 82.6, fp16: 165.2, source: WP_ADA },
  "RTX 4080": { fp32: 48.7, tf32: 48.7, fp16: 97.5, source: WP_ADA },
  "RTX 4080S": {
    fp32: 52.3,
    tf32: 52.3,
    fp16: 104.5,
    source: PAGE_4080,
    note: `RTX 4080 SUPER, 836 AI TOPS; ${ADA_NOTE}`,
  },
  "RTX 4070 Ti": {
    fp32: 40.1,
    tf32: 40.1,
    fp16: 80.2,
    source: WP_BLACKWELL,
  },
  "RTX 4070S Ti": {
    fp32: 44.1,
    tf32: 44.1,
    fp16: 88.3,
    source: PAGE_4070,
    note: `RTX 4070 Ti SUPER, 706 AI TOPS; ${ADA_NOTE}`,
  },
  "RTX 4070S": {
    fp32: 35.5,
    tf32: 35.5,
    fp16: 71,
    source: PAGE_4070,
    note: `RTX 4070 SUPER, 568 AI TOPS; ${ADA_NOTE}`,
  },
  "RTX 4070": { fp32: 29.1, tf32: 29.1, fp16: 58.3, source: WP_BLACKWELL },
  "RTX 4060 Ti": {
    fp32: 22.1,
    tf32: 22.1,
    fp16: 44.1,
    source: PAGE_4060,
    note: `353 AI TOPS; ${ADA_NOTE}`,
  },
  "RTX 4060": {
    fp32: 15.1,
    tf32: 15.1,
    fp16: 30.3,
    source: PAGE_4060,
    note: `242 AI TOPS; ${ADA_NOTE}`,
  },

  // GeForce Ampere
  "RTX 3090 Ti": { fp32: 40, tf32: 40, fp16: 80, source: WP_ADA },
  "RTX 3090": { fp32: 35.6, tf32: 35.6, fp16: 71, source: WP_AMPERE },
  "RTX 3080 Ti": { fp32: 34.1, tf32: 34.1, fp16: 68.2, source: WP_ADA },
  "RTX 3080": {
    fp32: 29.8,
    tf32: 29.8,
    fp16: 59.5,
    source: WP_AMPERE,
    note: "10 GB card (8704 cores); the 12 GB variant is faster",
  },
  "RTX 3070 Ti": { fp32: 21.7, tf32: 21.7, fp16: 43.5, source: WP_BLACKWELL },
  "RTX 3070": { fp32: 20.3, tf32: 20.3, fp16: 40.6, source: WP_AMPERE },
  "RTX 3060 Ti": {
    fp32: 16.2,
    tf32: 16.2,
    fp16: 32.5,
    source: PAGE_30,
    note: "fp32 = 2 x 4864 CUDA cores x 1.67 GHz boost from the page; tf32 = fp32 and fp16 = 2 x fp32, the GeForce Ampere ratios in the Ampere whitepaper (RTX 3090/3070)",
  },
  "RTX 3060": {
    fp32: 12.8,
    tf32: 12.8,
    fp16: 25.5,
    source: PAGE_30,
    note: "fp32 = 2 x 3584 CUDA cores x 1.78 GHz boost from the page; tf32 = fp32 and fp16 = 2 x fp32, the GeForce Ampere ratios in the Ampere whitepaper (RTX 3090/3070)",
  },

  // GeForce / Quadro / Titan Turing (no TF32)
  "RTX 2080 Ti": {
    fp32: 14.2,
    tf32: null,
    fp16: 56.9,
    source: WP_TURING,
    note: "Founders Edition clocks; the reference card is 13.4 / 53.8",
  },
  "RTX 2070S": { fp32: 9.1, tf32: null, fp16: 36.3, source: WP_AMPERE },
  "RTX 2070": {
    fp32: 7.5,
    tf32: null,
    fp16: 29.9,
    source: WP_TURING,
    note: "reference clocks; Founders Edition is 7.9 / 31.5",
  },
  "Titan RTX": { fp32: 16.3, tf32: null, fp16: 130.5, source: WP_AMPERE },
  "Q RTX 6000": { fp32: 16.3, tf32: null, fp16: 130.5, source: WP_TURING },
  "Q RTX 5000": { fp32: 11.2, tf32: null, fp16: 89.2, source: WP_TURING },
  "Tesla T4": { fp32: 8.1, tf32: null, fp16: 65, source: WP_TURING },

  // Volta and Pascal
  "Tesla V100": {
    fp32: 14,
    tf32: null,
    fp16: 112,
    source: DS_V100,
    note: "PCIe card; the SXM2 card is 15.7 / 125",
  },
  "Tesla V100S": { fp32: 16.4, tf32: null, fp16: 130, source: DS_V100 },
  "Tesla P100": {
    fp32: 9.3,
    tf32: null,
    fp16: null,
    source:
      "https://images.nvidia.com/content/tesla/pdf/nvidia-tesla-p100-PCIe-datasheet.pdf",
    note: "PCIe card; the SXM2 card is 10.6",
  },
  "Titan Xp": {
    fp32: 12,
    tf32: null,
    fp16: null,
    source:
      "https://web.archive.org/web/20180215210825if_/https://www.nvidia.com/en-us/titan/titan-xp/",
  },
  "GTX 1080 Ti": {
    fp32: 11.3,
    tf32: null,
    fp16: null,
    source: WP_TURING,
    note: "2 x 3584 CUDA cores x 1582 MHz boost, both from the Turing whitepaper table 1 (which prints 11.3 as the card's RTX-OPS)",
  },
  "GTX 1080": { fp32: 8.9, tf32: null, fp16: null, source: WP_TURING },
  "GTX 1070": { fp32: 6.5, tf32: null, fp16: null, source: WP_TURING },
  "GTX TITAN X": {
    fp32: 6.6,
    tf32: null,
    fp16: null,
    source:
      "https://www.nvidia.com/en-us/geforce/graphics-cards/geforce-gtx-titan-x/specifications",
    note: "2 x 3072 CUDA cores x 1075 MHz boost from the page",
  },

  // Data center and workstation Ampere
  "A100 PCIE": { fp32: 19.5, tf32: 156, fp16: 312, source: DS_A100 },
  "A100 SXM4": { fp32: 19.5, tf32: 156, fp16: 312, source: DS_A100 },
  A30: {
    fp32: 10.3,
    tf32: 82,
    fp16: 165,
    source:
      "https://www.nvidia.com/content/dam/en-zz/Solutions/data-center/products/a30-gpu/pdf/a30-datasheet.pdf",
  },
  A10: {
    fp32: 31.2,
    tf32: 62.5,
    fp16: 125,
    source:
      "https://www.nvidia.com/content/dam/en-zz/Solutions/Data-Center/a10/pdf/a10-datasheet.pdf",
  },
  A40: { fp32: 37.4, tf32: 74.8, fp16: 149.7, source: WP_AMPERE },
  "RTX A6000": { fp32: 38.7, tf32: 77.4, fp16: 154.8, source: WP_AMPERE },
  "RTX A5000": {
    fp32: 27.8,
    tf32: 55.6,
    fp16: 111.1,
    source:
      "https://www.nvidia.com/content/dam/en-zz/Solutions/products/workstations/nvidia-rtx-a5000-datasheet.pdf",
    note: "datasheet prints 222.2 tensor TFLOPS with sparsity: fp16 = 222.2 / 2, tf32 = fp16 / 2 (the RTX A6000 ratio in the Ampere whitepaper)",
  },
  "RTX A4000": {
    fp32: 19.2,
    tf32: 38.4,
    fp16: 76.7,
    source:
      "https://www.nvidia.com/content/dam/en-zz/Solutions/products/workstations/nvidia-rtx-a4000-datasheet.pdf",
    note: "datasheet prints 153.4 tensor TFLOPS with sparsity: fp16 = 153.4 / 2, tf32 = fp16 / 2 (the RTX A6000 ratio in the Ampere whitepaper)",
  },
  "RTX A2000": {
    fp32: 8,
    tf32: 16,
    fp16: 32,
    source:
      "https://www.nvidia.com/content/dam/en-zz/Solutions/products/workstations/nvidia-rtx-a2000-12gb-datasheet.pdf",
    note: "datasheet prints 63.9 tensor TFLOPS with sparsity: fp16 = 63.9 / 2, tf32 = fp16 / 2 (the RTX A6000 ratio in the Ampere whitepaper); 6 GB and 12 GB cards share the numbers",
  },

  // Ada data center and workstation
  L4: { fp32: 30.3, tf32: 60, fp16: 121, source: WP_ADA },
  L40: { fp32: 90.5, tf32: 90.5, fp16: 181, source: WP_ADA },
  L40S: {
    fp32: 91.6,
    tf32: 183,
    fp16: 362.05,
    source: "https://www.nvidia.com/en-gb/data-center/l40s",
  },
  "RTX 6000Ada": { fp32: 91.1, tf32: 182.1, fp16: 364, source: WP_PRO },

  // Hopper
  "H100 SXM": {
    fp32: 67,
    tf32: 494.5,
    fp16: 989.5,
    source: PAGE_H100,
    note: "page prints 989 / 1,979 with sparsity; halved",
  },
  "H100 PCIE": {
    fp32: 51,
    tf32: 378,
    fp16: 756.5,
    source: DS_H100_PCIE,
    note: "H100 datasheet (NVIDIA PDF, mirrored by megware.com) prints 756 / 1,513 with sparsity; halved",
  },
  "H100 NVL": {
    fp32: 60,
    tf32: 417.5,
    fp16: 835.5,
    source: PAGE_H100,
    note: "page prints 835 / 1,671 with sparsity; halved",
  },
  H200: {
    fp32: 67,
    tf32: 494.5,
    fp16: 989.5,
    source: PAGE_H200,
    note: "H200 SXM; page prints 989 / 1,979 with sparsity; halved",
  },
  "H200 NVL": {
    fp32: 60,
    tf32: 417.5,
    fp16: 835.5,
    source: PAGE_H200,
    note: "page prints 835 / 1,671 with sparsity; halved",
  },

  // Blackwell data center (per GPU = HGX baseboard total / 8)
  B200: {
    fp32: 75,
    tf32: 1125,
    fp16: 2250,
    source: PAGE_HGX,
    note: "HGX B200 table: FP32 600 TFLOPS, TF32 18 PFLOPS and FP16/BF16 36 PFLOPS with sparsity (dense is half), all divided by 8 GPUs",
  },
  B300: {
    fp32: 75,
    tf32: 1125,
    fp16: 2250,
    source: PAGE_HGX,
    note: "HGX B300 table: FP32 600 TFLOPS, TF32 18 PFLOPS and FP16/BF16 36 PFLOPS with sparsity (dense is half), all divided by 8 GPUs",
  },

  // RTX PRO Blackwell
  "RTX PRO 6000 WS": {
    fp32: 126,
    tf32: 251.9,
    fp16: 503.8,
    source: WP_PRO,
    note: "Workstation Edition",
  },
  "RTX PRO 6000 Max-Q": {
    fp32: 109.7,
    tf32: 219.5,
    fp16: 438.9,
    source: WP_PRO,
  },
  "RTX PRO 6000 S": {
    fp32: 120,
    tf32: 234,
    fp16: 468,
    source:
      "https://www.nvidia.com/en-us/data-center/rtx-pro-6000-blackwell-server-edition",
    note: "Server Edition; page prints FP32 120 and TF32 234; fp16 = 2 x tf32, the ratio in the RTX PRO Blackwell whitepaper (page only prints a rounded '1 PFLOP' with sparsity)",
  },
  "RTX PRO 5000": {
    fp32: 65,
    tf32: 129,
    fp16: 258,
    source:
      "https://www.nvidia.com/content/dam/en-zz/Solutions/products/workstations/professional-desktop-gpus/rtx-pro-5000-blackwell/workstation-datasheet-blackwell-rtx-pro-5000-5488550-nvidia.pdf",
    note: "derived from the datasheet's 2,064 AI TOPS (FP4 sparse): fp16 = AI TOPS / 8, tf32 = AI TOPS / 16; the same ratios reproduce the RTX PRO 6000 values in the whitepaper; 48 GB and 72 GB cards share the numbers",
  },
  "RTX PRO 4000": {
    fp32: 37,
    tf32: 73.6,
    fp16: 147.3,
    source:
      "https://www.nvidia.com/content/dam/en-zz/Solutions/products/workstations/professional-desktop-gpus/rtx-pro-4000/workstation-datasheet-rtx-pro-4000-nvidia-us-web.pdf",
    note: "derived from the datasheet's 1,178 AI TOPS (FP4 sparse): fp16 = AI TOPS / 8, tf32 = AI TOPS / 16; the product page prints 40 TFLOPS / 1,290 AI TOPS, the lower datasheet figures are used",
  },
};

/** Table row for a vast `gpu_name`; underscores count as spaces (`RTX_4090`). */
export function lookupGpu(gpuName: unknown): GpuPeak | undefined {
  if (typeof gpuName !== "string") return undefined;
  return (
    GPU_PRECISION[gpuName] ?? GPU_PRECISION[gpuName.replace(/_/g, " ").trim()]
  );
}

/** Peak dense TFLOPS per GPU for `precision`, or null when the table has none. */
export function peakTflops(
  gpuName: unknown,
  precision: Precision,
): number | null {
  return lookupGpu(gpuName)?.[precision] ?? null;
}
