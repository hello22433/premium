import { createCanvas, Image } from 'canvas';
import * as JsBarcode from 'jsbarcode';

import * as fs from 'fs';
import { join } from 'path';
import * as sharp from 'sharp';
import * as process from 'node:process';
import axios from 'axios';

// Helper: Buffer를 Canvas 이미지로 변환
function createImageFromBuffer(buffer: Buffer): Promise<any> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = (err) => reject(err);
    img.src = buffer;
  });
}

async function fetchImageBufferFromURL(url: string): Promise<Buffer> {
  const response = await axios.get(url, { responseType: 'arraybuffer' });
  return Buffer.from(response.data);
}

export const DeliveryCreateCouponImage = async (
  productImagePath: string,
  productName: string,
  barcodeValue: string,
  exchangeBrandName: string,
  expireDay: number,
  topImagePath: string,
  middleImagePath: string,
): Promise<{ fileName: string; path: string }> => {
  // 캔버스 크기 설정 (쿠폰 이미지 크기)
  const canvasWidth = 600;
  const canvasHeight = 900;
  const canvas = createCanvas(canvasWidth, canvasHeight);
  const ctx = canvas.getContext('2d');

  // 배경색 설정
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, canvasWidth, canvasHeight);

  // join(process.cwd(), '.', 'public/album/')
  const homeUrl = join(process.cwd(), '.');

  // 상단 배너 삽입
  const topImageBuffer = await fetchImageBufferFromURL(topImagePath); // S3 URL로부터 배너 이미지 가져오기

  const topImageResize = await sharp(topImageBuffer).resize(600, 200).toBuffer();
  const topImage = await createImageFromBuffer(topImageResize);
  ctx.drawImage(topImage, 0, 0);

  // 상품 이미지 삽입
  const productImageBuffer = await fetchImageBufferFromURL(productImagePath);
  const productImage = await sharp(productImageBuffer).resize(200, 200).toBuffer();
  const product = await createImageFromBuffer(productImage);
  ctx.drawImage(product, 50, 200);

  // 중간 이미지 삽입
  const midImageBuffer = await fetchImageBufferFromURL(middleImagePath); // S3 URL로부터 배너 이미지 가져오기
  const midImageResize = await sharp(midImageBuffer).resize(200, 200).toBuffer();
  const midImage = await createImageFromBuffer(midImageResize);
  ctx.drawImage(midImage, 350, 200);

  ctx.font = '20px "Noto Sans"';
  ctx.fillStyle = '#ff0000';
  ctx.fillText(`K 모바일쿠폰을 대표하는 이팝콘`, 150, 450);

  // 바코드 생성
  const barcodeCanvas = createCanvas(400, 100);
  JsBarcode(barcodeCanvas, `${barcodeValue}`, { format: 'CODE128' });
  const barcode = barcodeCanvas.toBuffer();
  const barcodeImage = await createImageFromBuffer(barcode);
  ctx.drawImage(barcodeImage, 200, 500);

  // 텍스트 추가
  ctx.font = '20px "Noto Sans"';
  ctx.fillStyle = '#000000';
  ctx.fillText(`상품명: ${productName}`, 20, 700);
  ctx.fillText(`교환처: ${exchangeBrandName}`, 20, 740);
  ctx.fillText(`유효기간: ${expireDay}일`, 20, 780);

  // 최종 이미지 저장
  const outputBuffer = canvas.toBuffer('image/jpeg');
  const now = new Date().getTime();
  const resultCouponFileName = `${now}-coupon.jpeg`;
  const path = `${homeUrl}/public/${resultCouponFileName}`;
  fs.writeFileSync(path, outputBuffer);

  return { fileName: resultCouponFileName, path };
};
