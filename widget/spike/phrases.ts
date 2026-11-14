// PLAN-21 M0: the phrases a tester reads aloud. Each one has key terms that must come through for
// the text to be usable without retyping (product names, order numbers, coupon codes, sizes).
// A key is a list of accepted spellings; any one of them counts. Product names and codes are the
// seed data's (commerce-api/src/database/seed-data.ts), since those are what shoppers will say.

export type Lang = 'en-US' | 'vi-VN';

export interface Phrase {
  id: string;
  lang: Lang;
  text: string;
  /** Each inner list is one key term; any spelling in it counts. */
  keys: string[][];
}

export const PHRASES: Phrase[] = [
  // English
  { id: 'en-01', lang: 'en-US', text: 'Do you have the Trailrunner 3 running shoes in size 42?',
    keys: [['trailrunner 3', 'trail runner 3', 'trailrunner three', 'trail runner three'], ['42', 'forty two']] },
  { id: 'en-02', lang: 'en-US', text: 'Where is my order ORD-1001?',
    keys: [['ord-1001', 'ord 1001', 'order 1001']] },
  { id: 'en-03', lang: 'en-US', text: 'I want to return order ORD-1002.',
    keys: [['return'], ['ord-1002', 'ord 1002', 'order 1002']] },
  { id: 'en-04', lang: 'en-US', text: 'Please apply the coupon SAVE20.',
    keys: [['save20', 'save 20', 'save twenty']] },
  { id: 'en-05', lang: 'en-US', text: 'Is the WELCOME10 code still valid?',
    keys: [['welcome10', 'welcome 10', 'welcome ten']] },
  { id: 'en-06', lang: 'en-US', text: 'Show me noise-cancelling headphones under 200 dollars.',
    keys: [['noise cancelling', 'noise canceling'], ['headphones'], ['200', '$200', 'two hundred']] },
  { id: 'en-07', lang: 'en-US', text: 'Compare the 28L Daypack and the 20L Commuter Backpack.',
    keys: [['28l', '28 l', '28 liter', '28 litre'], ['daypack', 'day pack'], ['20l', '20 l', '20 liter', '20 litre'], ['commuter']] },
  { id: 'en-08', lang: 'en-US', text: 'Do you sell a USB-C fast charger, 65 watt?',
    keys: [['usb-c', 'usb c', 'usbc'], ['charger'], ['65', '65w']] },
  { id: 'en-09', lang: 'en-US', text: 'Add the Merino Crew T-shirt in medium to my cart.',
    keys: [['merino'], ['crew'], ['t-shirt', 't shirt', 'tshirt'], ['medium'], ['cart']] },
  { id: 'en-10', lang: 'en-US', text: 'My CityWalk sneakers arrived damaged, can I talk to a person?',
    keys: [['citywalk', 'city walk'], ['sneakers'], ['damaged'], ['person']] },

  // Vietnamese, with the English product names and codes shoppers will actually say
  { id: 'vi-01', lang: 'vi-VN', text: 'Đơn hàng ORD-1001 của tôi đang ở đâu?',
    keys: [['đơn hàng'], ['ord-1001', 'ord 1001', 'order 1001']] },
  { id: 'vi-02', lang: 'vi-VN', text: 'Tôi muốn trả lại đơn ORD-1002.',
    keys: [['trả lại'], ['ord-1002', 'ord 1002', 'order 1002']] },
  { id: 'vi-03', lang: 'vi-VN', text: 'Áp dụng mã giảm giá SAVE20 giúp tôi.',
    keys: [['mã giảm giá'], ['save20', 'save 20']] },
  { id: 'vi-04', lang: 'vi-VN', text: 'Mã WELCOME10 còn dùng được không?',
    keys: [['welcome10', 'welcome 10']] },
  { id: 'vi-05', lang: 'vi-VN', text: 'Có giày chạy bộ Trailrunner 3 size 42 không?',
    keys: [['giày chạy bộ'], ['trailrunner 3', 'trail runner 3'], ['42']] },
  { id: 'vi-06', lang: 'vi-VN', text: 'Cho tôi xem tai nghe chống ồn dưới 5 triệu đồng.',
    keys: [['tai nghe'], ['chống ồn'], ['5 triệu', 'năm triệu', '5000000']] },
  { id: 'vi-07', lang: 'vi-VN', text: 'Áo khoác đi mưa có màu xanh không?',
    keys: [['áo khoác'], ['mưa'], ['xanh']] },
  { id: 'vi-08', lang: 'vi-VN', text: 'Thêm áo thun Merino cỡ M vào giỏ hàng.',
    keys: [['áo thun'], ['merino'], ['cỡ m', 'size m'], ['giỏ hàng']] },
  { id: 'vi-09', lang: 'vi-VN', text: 'Bình nước giữ nhiệt 1 lít giá bao nhiêu?',
    keys: [['bình nước'], ['giữ nhiệt'], ['1 lít', 'một lít', '1l'], ['bao nhiêu']] },
  { id: 'vi-10', lang: 'vi-VN', text: 'Tôi muốn nói chuyện với nhân viên.',
    keys: [['nói chuyện'], ['nhân viên']] },
];
