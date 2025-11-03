import { OrderDeliveryEntity } from '../../entity/order.delivery.entity';
import { format } from 'date-fns';

export const EmailEncourageTemplate = (orderDelivery: OrderDeliveryEntity) => {
  const barcodeLast4 = orderDelivery.barCode!.slice(-4);
  const expireDate = format(orderDelivery.expireAt!, 'yyyy/MM/dd');

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body>
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#ffffff; max-width:400px; margin:0 auto; border:1px solid #ddd;">
    <tr>
      <td style="padding:40px 20px; text-align:center;">
        <h2 style="color:#333; margin-bottom:30px;">미사용쿠폰발생 안내</h2>
        <div style="font-size:16px; line-height:1.8; color:#555;">
          <p>미사용쿠폰발생.</p>
          <p>뒷자리 <strong style="color:#ff3b30; font-size:18px;">${barcodeLast4}</strong>번.</p>
          <p><strong style="color:#ff3b30;">${expireDate}</strong>일까지 사용.</p>
          <p style="margin-top:30px; color:#999;">재발송문의 1644-3614</p>
        </div>
      </td>
    </tr>
  </table>
</body>
</html>
`;
};
