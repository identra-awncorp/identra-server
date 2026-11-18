// npm run demo:provision-product — creates the sample product chain of ADR-0012 §1 (GS1 demo
// prefix 952; not a real product): up to three events signed IN-PROCESS by the three sample
// organisations (san_xuat → kiem_dinh → phan_phoi), each stored through the same check as
// POST /v1/products/:gtin/:serial/events. Idempotent: stages already stored are skipped, so a
// second run changes nothing. Touches only VcStatusIndex/VcStatusList (status entries) and
// ProductEvent. Needs the server's environment (IDENTRA_KEYS_DIR, DATABASE_URL, REDIS_URL, …).
//
//   DEMO_PRODUCT_PROVISION=yes                 required (refuses otherwise)
//   DEMO_PRODUCT_SERIAL=SN-2026-000001         the serial (AI 21), default shown
//   DEMO_PRODUCT_STAGES=3                      1, 2 or 3 stages (2: the page's "in progress" state)
import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
import { CONG_DOAN, formatProductCode, type CongDoan } from '@identra/sdk-core';
import { appendProductEvent, type StatusListService } from '@identra/sdk-server';

import { AppModule } from '../app.module';
import { ProductEventsService } from '../vc/products';
import { PKI, Pki, STATUS_LIST_SERVICE } from '../vc/vc.providers';

export const DEMO_GTIN = '09520123456788';

/** Fictional but realistic sample content, clearly marked as DEMO; times in order and in the past. */
const STAGES: Record<CongDoan, { org: string; thoiDiem: string; diaDiem: string; moTa: string }> = {
  san_xuat: {
    org: 'nha-san-xuat',
    thoiDiem: '2026-11-02T01:30:00Z',
    diaDiem: 'Nhà máy rang xay Mẫu, Buôn Ma Thuột, Đắk Lắk (DEMO)',
    moTa: 'Cà phê Robusta rang mộc, lô DEMO-2026-11-A, túi 500 g. Dữ liệu mẫu, không phải hàng bán thật.'
  },
  kiem_dinh: {
    org: 'kiem-dinh',
    thoiDiem: '2026-11-05T03:00:00Z',
    diaDiem: 'Trung tâm Kiểm định Mẫu, Buôn Ma Thuột, Đắk Lắk (DEMO)',
    moTa: 'Đạt yêu cầu về độ ẩm, tạp chất và dư lượng; phiếu kết quả mẫu KD-DEMO-0042.'
  },
  phan_phoi: {
    org: 'phan-phoi',
    thoiDiem: '2026-11-10T08:15:00Z',
    diaDiem: 'Kho phân phối Mẫu, Quận 7, TP. Hồ Chí Minh (DEMO)',
    moTa: 'Nhập kho, bảo quản nơi khô ráo và giao cho đại lý bán lẻ mẫu.'
  }
};

async function main(): Promise<void> {
  const serial = process.env.DEMO_PRODUCT_SERIAL ?? 'SN-2026-000001';
  const stages = Number(process.env.DEMO_PRODUCT_STAGES ?? '3');

  if (process.env.DEMO_PRODUCT_PROVISION !== 'yes') {
    console.error('demo:provision-product refuses to run: set DEMO_PRODUCT_PROVISION=yes.');
    process.exitCode = 1;

    return;
  }

  // formatProductCode is the SDK's validator of GTIN and serial (isSerial is not exported).
  const valid = (() => {
    try {
      return Boolean(formatProductCode(DEMO_GTIN, serial));
    } catch {
      return false;
    }
  })();

  if (!valid || ![1, 2, 3].includes(stages)) {
    console.error('demo:provision-product: DEMO_PRODUCT_SERIAL must be a GS1 AI (21) value, DEMO_PRODUCT_STAGES 1 to 3.');
    process.exitCode = 1;

    return;
  }

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });

  try {
    const products = app.get(ProductEventsService);
    const statusLists = app.get<StatusListService>(STATUS_LIST_SERVICE);
    const pki = app.get<Pki>(PKI);

    for (const [index, congDoan] of CONG_DOAN.slice(0, stages).entries()) {
      const existing = await products.events(DEMO_GTIN, serial);

      if (existing.length > index) {
        console.log(`demo:provision-product: ${DEMO_GTIN}/${serial} ${congDoan} already stored`);
        continue;
      }

      const stage = STAGES[congDoan];
      const { uri, idx } = await statusLists.allocate(stage.org);
      const compact = await appendProductEvent({
        gtin: DEMO_GTIN,
        serial,
        existing,
        iss: pki.issuerUri(stage.org),
        status: { uri, idx },
        claims: { congDoan, thoiDiem: stage.thoiDiem, diaDiem: stage.diaDiem, moTa: stage.moTa },
        verify: products.verifyOptions(),
        signer: await pki.keyStore.signer(stage.org, 'vc'),
        hasher: pki.hasher,
        random: pki.random,
        clock: pki.clock
      });
      const { seq } = await products.store({ gtin: DEMO_GTIN, serial, compact, actingOrg: stage.org });

      console.log(`demo:provision-product: ${DEMO_GTIN}/${serial} ${congDoan} stored as seq ${seq}`);
    }
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  const code = (error as { getResponse?: () => { code?: string; reason?: string } })?.getResponse?.();

  console.error(`demo:provision-product failed: ${code ? `${code.code} ${code.reason ?? ''}` : error instanceof Error ? error.name : 'error'}`);
  process.exitCode = 1;
});
