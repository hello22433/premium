import { createCanvas, Image } from 'canvas';
import JsBarcode from 'jsbarcode';

import * as fsPromises from 'fs/promises';
import { join } from 'path';
import sharp from 'sharp';
import * as process from 'node:process';
import axios from 'axios';
import { IProductType } from '../../product/interface/product.type';

// Helper: Buffer를 Canvas 이미지로 변환
function createImageFromBuffer(buffer: Buffer): Promise<any> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = (err) => reject(err);
    img.src = buffer;
  });
}

// 기본 플레이스홀더 이미지 URL
const DEFAULT_PLACEHOLDER_IMAGE_URL = 'https://premium.epopkon.com/img/upload-plz.jpg';

// 쿠폰 이미지 합성 시 원본 비율 유지 + 중앙 정렬 (잘림 방지)
const COUPON_IMAGE_RESIZE_OPTIONS: sharp.ResizeOptions = {
  fit: 'contain',
  position: 'center',
  background: { r: 255, g: 255, b: 255, alpha: 1 },
};

async function fetchImageBufferFromURL(url: string): Promise<Buffer> {
  // URL이 없거나 유효하지 않은 경우 기본 이미지 URL 사용
  let targetUrl = url;
  if (!url || url.trim() === '') {
    targetUrl = DEFAULT_PLACEHOLDER_IMAGE_URL;
  } else {
    try {
      new URL(url);
    } catch {
      // URL이 유효하지 않은 경우 기본 이미지 URL 사용
      targetUrl = DEFAULT_PLACEHOLDER_IMAGE_URL;
    }
  }

  const response = await axios.get(targetUrl, { responseType: 'arraybuffer' });
  return Buffer.from(response.data);
}

export const DeliveryCreateCouponImage = async (
  productImagePath: string,
  productName: string,
  barcodeValue: string,
  exchangeBrandName: string,
  expireDate: string | null,
  topImagePath: string,
  middleImagePath: string,
  type: IProductType,
): Promise<{ fileName: string; path: string }> => {
  // 캔버스 크기 설정 (쿠폰 이미지 크기)
  const canvasWidth = 600;
  const canvasHeight = type === IProductType.SSG ? 680 : 900;
  const canvas = createCanvas(canvasWidth, canvasHeight);
  const ctx = canvas.getContext('2d');

  try {
    // 배경색 설정
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, canvasWidth, canvasHeight);

    const homeUrl = join(process.cwd(), '.');

    // 상단 배너 삽입
    const topImageBuffer = await fetchImageBufferFromURL(topImagePath);
    const topImageResize = await sharp(topImageBuffer).resize(600, 200).toBuffer();
    const topImage = await createImageFromBuffer(topImageResize);
    ctx.drawImage(topImage, 0, 0);

    // 상단 배너 아래에 구분선 추가
    ctx.beginPath();
    ctx.strokeStyle = '#D8D8D8';
    ctx.lineWidth = 3;
    ctx.moveTo(0, 200);
    ctx.lineTo(canvasWidth, 200);
    ctx.stroke();

    // 상품 이미지 삽입 (원본 비율 유지 + 중앙 정렬, 남는 공간은 흰 배경)
    const productImageBuffer = await fetchImageBufferFromURL(productImagePath);
    const productImage = await sharp(productImageBuffer)
      .resize(300, 300, COUPON_IMAGE_RESIZE_OPTIONS)
      .toBuffer();
    const product = await createImageFromBuffer(productImage);
    ctx.drawImage(product, 0, 200);

    // 중간 이미지 삽입 (원본 비율 유지 + 중앙 정렬, 남는 공간은 흰 배경)
    const midImageBuffer = await fetchImageBufferFromURL(middleImagePath);
    const midImageResize = await sharp(midImageBuffer)
      .resize(300, 300, COUPON_IMAGE_RESIZE_OPTIONS)
      .toBuffer();
    const midImage = await createImageFromBuffer(midImageResize);
    ctx.drawImage(midImage, 300, 200);

    // 상품 이미지와 중간 이미지 사이에 세로 구분선 추가
    ctx.beginPath();
    ctx.strokeStyle = '#D8D8D8';
    ctx.lineWidth = 2;
    ctx.moveTo(300, 200);
    ctx.lineTo(300, 500);
    ctx.stroke();

    // 상품 이미지와 중간 이미지 하단에 가로 구분선 추가
    ctx.beginPath();
    ctx.strokeStyle = '#D8D8D8';
    ctx.lineWidth = 2;
    ctx.moveTo(0, 500);
    ctx.lineTo(canvasWidth, 500);
    ctx.stroke();

    // 신세계 아닐 때만 바코드 레이어 생성
    if (type !== IProductType.SSG) {
      ctx.font = '24px "Noto Sans"';
      ctx.fillStyle = '#ff0000';
      ctx.fillText(`K 모바일쿠폰을 대표하는 이팝콘`, 150, 550);

      // 바코드 생성
      const barcodeCanvas = createCanvas(500, 100);
      JsBarcode(barcodeCanvas, `${barcodeValue}`, {
        format: 'CODE128',
        width: 4,
        height: 70,
        displayValue: true,
        fontSize: 20,
        textMargin: 15,
        margin: 10,
        background: '#ffffff',
        lineColor: '#000000',
        textAlign: 'center',
      });

      // 캔버스를 PNG 버퍼로 변환
      const barcodeBuffer = barcodeCanvas.toBuffer('image/png');

      // sharp를 사용하여 이미지 주변의 공백을 자동으로 제거
      const trimmedBarcodeBuffer = await sharp(barcodeBuffer).trim().toBuffer();

      // 공백이 제거된 이미지의 너비를 얻기 위해 metadata() 사용
      const barcodeMetadata = await sharp(trimmedBarcodeBuffer).metadata();
      const barcodeWidth = barcodeMetadata.width;

      // 공백이 제거된 버퍼로부터 최종 바코드 이미지 생성
      const barcodeImage = await createImageFromBuffer(trimmedBarcodeBuffer);

      // 메인 캔버스의 중앙에 바코드를 그리기 위한 x 좌표 계산
      const barcodeX = (canvasWidth - barcodeWidth!) / 2;

      // 계산된 중앙 위치에 바코드 이미지 그리기
      ctx.drawImage(barcodeImage, barcodeX, 580);

      // 바코드 캔버스 네이티브 메모리 해제
      barcodeCanvas.width = 0;
      barcodeCanvas.height = 0;

      // 바코드 아래에 구분선 추가
      ctx.beginPath();
      ctx.strokeStyle = '#D8D8D8';
      ctx.lineWidth = 2;
      ctx.moveTo(0, 710);
      ctx.lineTo(canvasWidth, 710);
      ctx.stroke();
    }

    // 텍스트 추가 - SSG는 바코드 영역 없이 위쪽에 배치
    ctx.font = '24px "Noto Sans"';
    ctx.fillStyle = '#585858';
    if (type === IProductType.SSG) {
      ctx.fillText(`상품명: ${productName}`, 40, 550);
      ctx.fillText(`사용처(교환처): 이마트`, 40, 590);
      ctx.fillText(`유효기간: ~ ${expireDate}`, 40, 630);
    } else {
      ctx.fillText(`상품명: ${productName}`, 40, 770);
      ctx.fillText(`사용처(교환처): ${exchangeBrandName}`, 40, 810);
      ctx.fillText(`유효기간: ~ ${expireDate}`, 40, 850);
    }

    // 최종 이미지 저장 (비동기)
    const outputBuffer = canvas.toBuffer('image/jpeg');
    const now = new Date().getTime();
    const resultCouponFileName = `${now}-coupon.jpeg`;
    const path = `${homeUrl}/public/${resultCouponFileName}`;
    await fsPromises.writeFile(path, outputBuffer);

    return { fileName: resultCouponFileName, path };
  } finally {
    // Canvas 네이티브 메모리 해제
    canvas.width = 0;
    canvas.height = 0;
  }
};
