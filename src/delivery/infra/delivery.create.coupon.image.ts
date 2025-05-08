import { createCanvas, Image } from 'canvas';
import * as JsBarcode from 'jsbarcode';

import * as fs from 'fs';
import { join } from 'path';
import * as sharp from 'sharp';
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
  expireDay: number,
  topImagePath: string,
  middleImagePath: string,
  type: any,
): Promise<{ fileName: string; path: string }> => {
  // 캔버스 크기 설정 (쿠폰 이미지 크기)
  const canvasWidth = 600;
  const canvasHeight = type === IProductType.SSG ? 850 : 900;
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

    // 바코드 생성 - 더 넓고 뚱뚱하고 짧게 설정
    const barcodeCanvas = createCanvas(500, 100); // 너비 증가, 높이 감소
    JsBarcode(barcodeCanvas, `${barcodeValue}`, {
      format: 'CODE128',
      width: 4, // 바 두께 증가 (기본값보다 두껍게)
      height: 70, // 바코드 높이 설정
      displayValue: true, // 바코드 아래 텍스트 표시
      fontSize: 20, // 바코드 텍스트 크기
      textMargin: 15, // 텍스트와 바코드 사이 간격
      margin: 0, // 바코드 좌우 여백 최소화
      background: '#ffffff', // 배경색
      lineColor: '#000000', // 바코드 색상
    });

    const barcode = barcodeCanvas.toBuffer();
    const barcodeImage = await createImageFromBuffer(barcode);

    ctx.drawImage(barcodeImage, 50, 580); // x 위치를 왼쪽으로 조정 (더 넓어진 바코드를 위해)

    // 바코드 아래에 구분선 추가
    ctx.beginPath();
    ctx.strokeStyle = '#D8D8D8'; // 선 색상 설정 (다른 구분선과 동일)
    ctx.lineWidth = 2; // 선 두께 설정
    ctx.moveTo(0, 710); // 선의 시작점 (왼쪽 끝, 바코드 아래)
    ctx.lineTo(canvasWidth, 710); // 선의 끝점 (오른쪽 끝)
    ctx.stroke(); // 선 그리기
  }

  // 텍스트 추가
  ctx.font = '24px "Noto Sans"';
  ctx.fillStyle = '#585858';
  ctx.fillText(`상품명: ${productName}`, 40, 770);
  ctx.fillText(`교환처: ${exchangeBrandName}`, 40, 810);
  ctx.fillText(`유효기간: ${expireDay}일`, 40, 850);

  // 최종 이미지 저장
  const outputBuffer = canvas.toBuffer('image/jpeg');
  const now = new Date().getTime();
  const resultCouponFileName = `${now}-coupon.jpeg`;
  const path = `${homeUrl}/public/${resultCouponFileName}`;
  fs.writeFileSync(path, outputBuffer);

  return { fileName: resultCouponFileName, path };
};
