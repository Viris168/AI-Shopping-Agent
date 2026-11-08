import { trackingUrl } from './orders.module.js';

describe('trackingUrl', () => {
  it('links each supported carrier to its tracking page', () => {
    expect(trackingUrl('UPS', '1Z999AA10123456784')).toBe(
      'https://www.ups.com/track?loc=en_US&tracknum=1Z999AA10123456784',
    );
    expect(trackingUrl('FedEx', '612999AA10123456')).toContain(
      'fedex.com/fedextrack/?trknbr=612999AA10123456',
    );
    expect(trackingUrl('USPS', '9400111899223197428490')).toContain(
      'tools.usps.com/go/TrackConfirmAction?tLabels=9400111899223197428490',
    );
    expect(trackingUrl('DHL', '1234567890')).toContain(
      'dhl.com/global-en/home/tracking/tracking-express.html?submit=1&tracking-id=1234567890',
    );
  });

  it('accepts common carrier spellings and spaced tracking numbers', () => {
    expect(trackingUrl('Federal Express', '6129 99AA 1012 3456')).toContain(
      'trknbr=612999AA10123456',
    );
    expect(trackingUrl('united states postal service', '9400111899')).toContain(
      'usps.com',
    );
    expect(trackingUrl('DHL Express', '1234567890')).toContain('dhl.com');
  });

  it('gives no link for unknown carriers, missing data or malformed numbers', () => {
    expect(trackingUrl('Pigeon Post', '1234567890')).toBeNull();
    expect(trackingUrl(null, '1234567890')).toBeNull();
    expect(trackingUrl('UPS', null)).toBeNull();
    expect(trackingUrl('UPS', '1Z99&evil=1')).toBeNull();
    expect(trackingUrl('UPS', 'short')).toBeNull();
  });
});
