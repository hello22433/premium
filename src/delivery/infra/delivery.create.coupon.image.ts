import { createCanvas, Image } from 'canvas';
import * as JsBarcode from 'jsbarcode';

import * as fs from 'fs';
import { join } from 'path';
import * as sharp from 'sharp';
import * as process from 'node:process';

// Helper: Buffer를 Canvas 이미지로 변환
function createImageFromBuffer(buffer: Buffer): Promise<any> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = (err) => reject(err);
    img.src = buffer;
  });
}

export const DeliveryCreateCouponImage = async (
  productImagePath: string,
  productName: string,
  barcodeValue: string,
  exchangeBrandName: string,
  expireDay: number,
): Promise<{ fileName: string }> => {
  // 캔버스 크기 설정 (쿠폰 이미지 크기)
  const canvasWidth = 600;
  const canvasHeight = 900;
  const canvas = createCanvas(canvasWidth, canvasHeight);
  const ctx = canvas.getContext('2d');

  // 배경색 설정
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, canvasWidth, canvasHeight);

  // 상단 배너 삽입
  // join(process.cwd(), '.', 'public/album/')
  // const homeUrl = 'http://localhost:3000';
  const homeUrl = join(process.cwd(), '.');

  const bannerImage = await sharp(`${homeUrl}/public/coupon/coupon-ttl.jpg`).resize(600, 200).toBuffer();
  const banner = await createImageFromBuffer(bannerImage);
  ctx.drawImage(banner, 0, 0);

  // 상품 이미지 삽입
  const productImage = await sharp(`${homeUrl}${productImagePath}`).resize(200, 200).toBuffer();
  const product = await createImageFromBuffer(productImage);
  ctx.drawImage(product, 200, 200);

  // 바코드 생성
  const barcodeCanvas = createCanvas(400, 100);
  JsBarcode(barcodeCanvas, `${barcodeValue}`, { format: 'CODE128' });
  const barcode = barcodeCanvas.toBuffer();
  const barcodeImage = await createImageFromBuffer(barcode);
  ctx.drawImage(barcodeImage, 100, 500);

  // 텍스트 추가
  ctx.font = '20px Arial';
  ctx.fillStyle = '#000000';
  ctx.fillText(`상품명: ${productName}`, 20, 700);
  ctx.fillText(`교환처: ${exchangeBrandName}`, 20, 750);
  ctx.fillText(`유효기간: ${expireDay}일`, 20, 800);

  // 최종 이미지 저장
  const outputBuffer = canvas.toBuffer('image/png');
  const now = new Date().getTime();
  const resultCouponFileName = `${now}-coupon.png`;
  fs.writeFileSync(`${homeUrl}/public/${resultCouponFileName}`, outputBuffer);

  return { fileName: resultCouponFileName };
};
