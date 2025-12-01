import { createCanvas, Image } from 'canvas';
import JsBarcode from 'jsbarcode';

import * as fs from 'fs';
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

async function fetchImageBufferFromURL(url: string): Promise<Buffer> {
  const response = await axios.get(url, { responseType: 'arraybuffer' });
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
  type: any,
): Promise<{ fileName: string; path: string }> => {
  // 캔버스 크기 설정 (쿠폰 이미지 크기)
  const canvasWidth = 600;
  const canvasHeight = type === IProductType.SSG ? 680 : 900;
  const canvas = createCanvas(canvasWidth, canvasHeight);
  const ctx = canvas.getContext('2d');

  // 배경색 설정
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, canvasWidth, canvasHeight);

  const homeUrl = join(process.cwd(), '.');

  // 상단 배너 삽입
  const topImageBuffer = await fetchImageBufferFromURL(topImagePath); // S3 URL로부터 배너 이미지 가져오기

  const topImageResize = await sharp(topImageBuffer).resize(600, 200).toBuffer();
  const topImage = await createImageFromBuffer(topImageResize);
  ctx.drawImage(topImage, 0, 0);

  // 상단 배너 아래에 구분선 추가
  ctx.beginPath();
  ctx.strokeStyle = '#D8D8D8'; // 선 색상 설정 (검정색)
  ctx.lineWidth = 3; // 선 두께 설정
  ctx.moveTo(0, 200); // 선의 시작점 (왼쪽 끝, 상단 배너 바로 아래)
  ctx.lineTo(canvasWidth, 200); // 선의 끝점 (오른쪽 끝, 상단 배너 바로 아래)
  ctx.stroke(); // 선 그리기

  // 상품 이미지 삽입
  const productImageBuffer = await fetchImageBufferFromURL(productImagePath);
  const productImage = await sharp(productImageBuffer).resize(300, 300).toBuffer();
  const product = await createImageFromBuffer(productImage);
  ctx.drawImage(product, 0, 200);

  // 중간 이미지 삽입
  const midImageBuffer = await fetchImageBufferFromURL(middleImagePath); // S3 URL로부터 배너 이미지 가져오기
  const midImageResize = await sharp(midImageBuffer).resize(300, 300).toBuffer();
  const midImage = await createImageFromBuffer(midImageResize);
  ctx.drawImage(midImage, 300, 200);

  // 상품 이미지와 중간 이미지 사이에 세로 구분선 추가
  ctx.beginPath();
  ctx.strokeStyle = '#D8D8D8'; // 선 색상 설정 (상단 구분선과 동일)
  ctx.lineWidth = 2; // 선 두께 설정
  ctx.moveTo(300, 200); // 선의 시작점 (두 이미지 경계, 상단에서 시작)
  ctx.lineTo(300, 500); // 선의 끝점 (두 이미지 경계, 하단까지)
  ctx.stroke(); // 선 그리기

  // 상품 이미지와 중간 이미지 하단에 가로 구분선 추가
  ctx.beginPath();
  ctx.strokeStyle = '#D8D8D8'; // 선 색상 설정 (다른 구분선과 동일)
  ctx.lineWidth = 2; // 선 두께 설정
  ctx.moveTo(0, 500); // 선의 시작점 (왼쪽 끝, 이미지 하단)
  ctx.lineTo(canvasWidth, 500); // 선의 끝점 (오른쪽 끝, 이미지 하단)
  ctx.stroke(); // 선 그리기

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
      margin: 10, // sharp의 trim()이 배경을 인식할 수 있도록 약간의 여백을 줍니다.
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

    // 바코드 아래에 구분선 추가
    ctx.beginPath();
    ctx.strokeStyle = '#D8D8D8'; // 선 색상 설정 (다른 구분선과 동일)
    ctx.lineWidth = 2; // 선 두께 설정
    ctx.moveTo(0, 710); // 선의 시작점 (왼쪽 끝, 바코드 아래)
    ctx.lineTo(canvasWidth, 710); // 선의 끝점 (오른쪽 끝)
    ctx.stroke(); // 선 그리기
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

  // 최종 이미지 저장
  const outputBuffer = canvas.toBuffer('image/jpeg');
  const now = new Date().getTime();
  const resultCouponFileName = `${now}-coupon.jpeg`;
  const path = `${homeUrl}/public/${resultCouponFileName}`;
  fs.writeFileSync(path, outputBuffer);

  return { fileName: resultCouponFileName, path };
};
