/**
 * Seeds the category filter registry (WORK_PLAN F3): one set of filter
 * attributes per category — Fashion sizes, fits, sleeves …; Gadgets RAM,
 * storage, screen size …; Grocery dietary and pack sizes; Home rooms and
 * materials; Beauty skin type, shade, fragrance family; Sports — plus the
 * global Colour and Warranty. Safe to run again: attributes are matched by
 * code and values by name; nothing an admin added is removed.
 *
 * Then it tags the DummyJSON demo products (sku DEMO-DJ-<id>) with the values
 * their source data states: department and product type from the DummyJSON
 * category, colour from the title, material / sleeve / fit / pattern /
 * fragrance notes from the description, RAM / storage / screen / processor
 * from the specs text, warranty from warrantyInformation, OS from the brand.
 * Products shops added themselves are not touched.
 *
 * DummyJSON has no sizes. With DEMO_SIZES=1 the demo apparel gets S–XL and the
 * demo shoes UK 6–10 so the size filters can be tried; that is demo data, say
 * so wherever it shows.
 *
 *   node scripts/seed-filter-attributes.js            # registry + real facts
 *   DEMO_SIZES=1 node scripts/seed-filter-attributes.js
 */
require('dotenv').config();
const pool = require('../src/config/db');

// ── The registry ─────────────────────────────────────────────────────────────
// Each entry: code, name, category (name or null = every category), kind
// (chips | swatch | range | toggle), unit, subcategories (only shown once one of
// these is chosen; null = whole category), variant (defines variants),
// values: ['A', 'B'] or [['Red', '#D32F2F'], …] for swatches.

const APPAREL = ['Men', 'Women', 'Kids', 'Boys', 'Girls', 'Ethnic wear', 'Innerwear', 'Sportswear', 'Nightwear'];
const FOOTWEAR = ['Footwear', 'Men', 'Women', 'Kids', 'Boys', 'Girls', 'Sportswear'];
const ACCESSORIES = ['Accessories', 'Watches', 'Bags', 'Men', 'Women'];
const COMPUTING = ['Mobiles', 'Laptops', 'Tablets'];

const COLOURS = [
  ['Black', '#111111'], ['White', '#FFFFFF'], ['Grey', '#9E9E9E'], ['Navy', '#1F2A5A'], ['Blue', '#0D4FD1'],
  ['Red', '#D32F2F'], ['Pink', '#EC407A'], ['Maroon', '#7B1F2B'], ['Green', '#2E7D32'], ['Olive', '#6B7A2A'],
  ['Yellow', '#FBC02D'], ['Orange', '#FB8C00'], ['Brown', '#6D4C41'], ['Beige', '#D7C4A3'], ['Purple', '#7E57C2'],
  ['Gold', '#C9A227'], ['Silver', '#B0BEC5'], ['Multicolour', null],
];

const REGISTRY = [
  // ── Every category ──
  { code: 'colour', name: 'Colour', category: null, kind: 'swatch', variant: true, values: COLOURS },
  { code: 'warranty', name: 'Warranty', category: null, kind: 'chips', values: ['No warranty', 'Up to 6 months', '1 year', '2 years', '3 years or more', 'Lifetime'] },

  // ── Fashion ──
  { code: 'department', name: 'Department', category: 'Fashion', kind: 'chips', values: ['Men', 'Women', 'Boys', 'Girls', 'Unisex'] },
  { code: 'fashion_type', name: 'Product type', category: 'Fashion', kind: 'chips', values: [
    'T-shirt', 'Polo', 'Shirt', 'Jeans', 'Trousers', 'Shorts', 'Joggers', 'Hoodie', 'Sweatshirt', 'Jacket', 'Blazer',
    'Dress', 'Top', 'Skirt', 'Kurti', 'Kurta', 'Saree', 'Leggings', 'Innerwear', 'Nightwear', 'Activewear',
    'Sneakers', 'Casual shoes', 'Formal shoes', 'Sandals', 'Slippers', 'Boots', 'Sports shoes',
    'Watch', 'Sunglasses', 'Bag', 'Belt', 'Wallet', 'Cap', 'Jewellery', 'Socks',
  ] },
  { code: 'size', name: 'Size', category: 'Fashion', kind: 'chips', subcategories: APPAREL, variant: true, values: ['XS', 'S', 'M', 'L', 'XL', 'XXL', '3XL', 'Free size'] },
  { code: 'waist', name: 'Waist', category: 'Fashion', kind: 'chips', unit: 'in', subcategories: APPAREL, variant: true, values: ['28', '30', '32', '34', '36', '38', '40'] },
  { code: 'shoe_size', name: 'Shoe size', category: 'Fashion', kind: 'chips', unit: 'UK', subcategories: FOOTWEAR, variant: true, values: ['UK 3', 'UK 4', 'UK 5', 'UK 6', 'UK 7', 'UK 8', 'UK 9', 'UK 10', 'UK 11', 'UK 12'] },
  { code: 'fabric', name: 'Material', category: 'Fashion', kind: 'chips', values: [
    'Cotton', 'Organic cotton', 'Linen', 'Denim', 'Polyester', 'Cotton blend', 'Rayon / Viscose', 'Wool', 'Fleece', 'Silk',
    'Leather', 'Synthetic', 'Nylon', 'Canvas', 'Metal', 'Stainless steel',
  ] },
  { code: 'fit', name: 'Fit', category: 'Fashion', kind: 'chips', subcategories: APPAREL, values: ['Slim', 'Regular', 'Relaxed', 'Oversized', 'Loose', 'Straight', 'Skinny', 'Tapered'] },
  { code: 'pattern', name: 'Pattern', category: 'Fashion', kind: 'chips', values: ['Solid', 'Striped', 'Checked', 'Printed', 'Graphic', 'Floral', 'Textured', 'Embroidered'] },
  { code: 'sleeve', name: 'Sleeve', category: 'Fashion', kind: 'chips', subcategories: APPAREL, values: ['Sleeveless', 'Half sleeve', 'Three-quarter sleeve', 'Full sleeve'] },
  { code: 'neck', name: 'Neck / collar', category: 'Fashion', kind: 'chips', subcategories: APPAREL, values: ['Crew neck', 'Round neck', 'V-neck', 'Polo collar', 'Spread collar', 'Mandarin collar', 'Hooded'] },
  { code: 'rise', name: 'Rise', category: 'Fashion', kind: 'chips', subcategories: APPAREL, values: ['Low rise', 'Mid rise', 'High rise'] },
  { code: 'length', name: 'Length', category: 'Fashion', kind: 'chips', subcategories: APPAREL, values: ['Cropped', 'Regular length', 'Mini', 'Knee length', 'Midi', 'Maxi', 'Ankle length'] },
  { code: 'occasion', name: 'Occasion', category: 'Fashion', kind: 'chips', values: ['Casual', 'Formal', 'Party', 'Festive', 'Workwear', 'Sports', 'Ethnic'] },
  { code: 'style', name: 'Style', category: 'Fashion', kind: 'chips', values: ['Basic', 'Premium', 'Streetwear', 'Minimal', 'Trendy', 'Classic'] },
  { code: 'season', name: 'Season', category: 'Fashion', kind: 'chips', values: ['Summer', 'Winter', 'Monsoon', 'All season'] },
  { code: 'sustainability', name: 'Sustainability', category: 'Fashion', kind: 'chips', values: ['Organic', 'Recycled', 'Handloom', 'Vegan leather'] },
  { code: 'strap', name: 'Strap', category: 'Fashion', kind: 'chips', subcategories: ACCESSORIES, values: ['Leather strap', 'Metal strap', 'Silicone strap', 'Fabric strap'] },
  { code: 'dial', name: 'Dial shape', category: 'Fashion', kind: 'chips', subcategories: ACCESSORIES, values: ['Round', 'Square', 'Rectangular'] },
  { code: 'frame', name: 'Frame shape', category: 'Fashion', kind: 'chips', subcategories: ACCESSORIES, values: ['Aviator', 'Wayfarer', 'Round frame', 'Square frame', 'Cat eye'] },

  // ── Gadgets ──
  { code: 'gadget_type', name: 'Product type', category: 'Gadgets', kind: 'chips', values: [
    'Smartphone', 'Feature phone', 'Laptop', 'Tablet', 'Smartwatch', 'Earphones', 'Headphones', 'Speaker', 'Charger', 'Cable',
    'Power bank', 'Case & cover', 'Screen guard', 'Camera', 'TV', 'Monitor', 'Keyboard', 'Mouse', 'Storage',
  ] },
  { code: 'ram', name: 'RAM', category: 'Gadgets', kind: 'chips', unit: 'GB', subcategories: COMPUTING, variant: true, values: ['2 GB', '3 GB', '4 GB', '6 GB', '8 GB', '12 GB', '16 GB', '32 GB'] },
  { code: 'storage', name: 'Storage', category: 'Gadgets', kind: 'chips', unit: 'GB', subcategories: COMPUTING, variant: true, values: ['32 GB', '64 GB', '128 GB', '256 GB', '512 GB', '1 TB', '2 TB'] },
  { code: 'screen', name: 'Screen size', category: 'Gadgets', kind: 'range', unit: 'inch', subcategories: COMPUTING, values: ['5.5', '6.1', '6.5', '6.7', '10.1', '11', '12.9', '13', '14', '15.6', '16', '17'] },
  { code: 'battery', name: 'Battery', category: 'Gadgets', kind: 'chips', unit: 'mAh', subcategories: ['Mobiles', 'Tablets'], values: ['Under 4,000 mAh', '4,000 – 5,000 mAh', '5,000 mAh or more'] },
  { code: 'processor', name: 'Processor', category: 'Gadgets', kind: 'chips', subcategories: ['Laptops', 'Tablets'], values: ['Intel Core i3', 'Intel Core i5', 'Intel Core i7', 'Intel Core i9', 'AMD Ryzen 3', 'AMD Ryzen 5', 'AMD Ryzen 7', 'Apple M1', 'Apple M2', 'Apple M3'] },
  { code: 'os', name: 'Operating system', category: 'Gadgets', kind: 'chips', values: ['Android', 'iOS', 'Windows', 'macOS', 'ChromeOS', 'Wear OS'] },
  { code: 'connectivity', name: 'Connectivity', category: 'Gadgets', kind: 'chips', values: ['5G', '4G', 'Wi-Fi', 'Bluetooth', 'Wired', 'NFC'] },
  { code: 'features', name: 'Features', category: 'Gadgets', kind: 'chips', values: ['Fast charging', 'Wireless charging', 'Water resistant', 'Dual SIM', 'Fingerprint', 'Face unlock', 'Noise cancelling', 'Touchscreen', 'Backlit keyboard'] },
  { code: 'condition', name: 'Condition', category: 'Gadgets', kind: 'chips', values: ['New', 'Refurbished', 'Open box'] },

  // ── Grocery ──
  { code: 'dietary', name: 'Dietary', category: 'Grocery', kind: 'chips', values: ['Vegetarian', 'Vegan', 'Organic', 'Gluten-free', 'Sugar-free', 'Jain', 'High protein', 'Keto'] },
  { code: 'form', name: 'Form', category: 'Grocery', kind: 'chips', values: ['Fresh', 'Frozen', 'Dried', 'Packaged', 'Ready to cook', 'Ready to eat'] },
  { code: 'weight', name: 'Weight / volume', category: 'Grocery', kind: 'chips', variant: true, values: ['100 g', '200 g', '250 g', '500 g', '1 kg', '2 kg', '5 kg', '10 kg', '250 ml', '500 ml', '1 L', '2 L', '5 L'] },

  // ── Home ──
  { code: 'home_type', name: 'Product type', category: 'Home', kind: 'chips', values: [
    'Sofa', 'Bed', 'Table', 'Chair', 'Wardrobe', 'Shelf', 'Mattress', 'Cookware', 'Cutlery', 'Dinnerware', 'Storage', 'Lighting',
    'Wall decor', 'Showpiece & vase', 'Curtains', 'Bedsheet', 'Pillow', 'Cushion', 'Rug', 'Kitchen appliance', 'Cleaning',
  ] },
  { code: 'room', name: 'Room', category: 'Home', kind: 'chips', values: ['Living room', 'Bedroom', 'Kitchen', 'Dining', 'Bathroom', 'Study', 'Outdoor', 'Kids room'] },
  { code: 'home_material', name: 'Material', category: 'Home', kind: 'chips', values: ['Wood', 'Engineered wood', 'Metal', 'Stainless steel', 'Glass', 'Ceramic', 'Plastic', 'Fabric', 'Cotton', 'Bamboo', 'Marble', 'Silicone', 'Non-stick', 'Cast iron'] },
  { code: 'capacity', name: 'Capacity', category: 'Home', kind: 'chips', subcategories: ['Kitchen'], values: ['Under 1 L', '1 – 2 L', '2 – 5 L', '5 L or more', '1 piece', 'Set of 2', 'Set of 4', 'Set of 6'] },
  { code: 'power', name: 'Power', category: 'Home', kind: 'chips', unit: 'W', subcategories: ['Kitchen'], values: ['Under 500 W', '500 – 1,000 W', '1,000 – 1,500 W', '1,500 W or more'] },
  { code: 'assembly', name: 'Assembly', category: 'Home', kind: 'chips', subcategories: ['Furniture'], values: ['Pre-assembled', 'DIY assembly'] },
  { code: 'seating', name: 'Seats', category: 'Home', kind: 'chips', subcategories: ['Furniture'], values: ['1 seater', '2 seater', '3 seater', '4 seater', '6 seater or more'] },

  // ── Beauty ──
  { code: 'beauty_type', name: 'Product type', category: 'Beauty', kind: 'chips', values: [
    'Face wash', 'Moisturiser', 'Sunscreen', 'Serum', 'Face mask', 'Lipstick', 'Mascara', 'Eyeshadow', 'Foundation', 'Face powder',
    'Nail polish', 'Perfume', 'Deodorant', 'Shampoo', 'Conditioner', 'Hair oil', 'Body lotion', 'Body wash', 'Soap', 'Hand wash',
  ] },
  { code: 'for', name: 'For', category: 'Beauty', kind: 'chips', values: ['Men', 'Women', 'Unisex', 'Kids'] },
  { code: 'skin_type', name: 'Skin type', category: 'Beauty', kind: 'chips', subcategories: ['Skin care', 'Makeup'], values: ['Normal', 'Dry', 'Oily', 'Combination', 'Sensitive', 'All skin types'] },
  { code: 'concern', name: 'Concern', category: 'Beauty', kind: 'chips', subcategories: ['Skin care', 'Hair care'], values: ['Acne', 'Dark spots', 'Ageing', 'Dullness', 'Dryness', 'Pigmentation', 'Hydration', 'Tan', 'Hair fall', 'Dandruff'] },
  { code: 'formulation', name: 'Formulation', category: 'Beauty', kind: 'chips', values: ['Cream', 'Gel', 'Liquid', 'Powder', 'Oil', 'Foam', 'Spray', 'Stick', 'Bar', 'Sheet'] },
  { code: 'finish', name: 'Finish', category: 'Beauty', kind: 'chips', subcategories: ['Makeup'], values: ['Matte', 'Glossy', 'Satin', 'Shimmer', 'Natural'] },
  { code: 'shade', name: 'Shade', category: 'Beauty', kind: 'swatch', subcategories: ['Makeup'], variant: true, values: [
    ['Red', '#C62828'], ['Pink', '#EC407A'], ['Nude', '#D4A28C'], ['Brown', '#6D4C41'], ['Coral', '#FF7F50'], ['Berry', '#8E244D'], ['Black', '#111111'], ['Clear', null],
  ] },
  { code: 'fragrance_family', name: 'Fragrance family', category: 'Beauty', kind: 'chips', subcategories: ['Fragrances'], values: ['Floral', 'Woody', 'Fresh', 'Citrus', 'Oriental', 'Fruity', 'Aquatic', 'Musky'] },
  { code: 'fragrance_strength', name: 'Concentration', category: 'Beauty', kind: 'chips', subcategories: ['Fragrances'], values: ['Eau de Parfum', 'Eau de Toilette', 'Eau de Cologne', 'Body mist', 'Attar'] },
  { code: 'hair_type', name: 'Hair type', category: 'Beauty', kind: 'chips', subcategories: ['Hair care'], values: ['Normal', 'Dry', 'Oily', 'Curly', 'Straight', 'Frizzy', 'Coloured'] },
  { code: 'volume', name: 'Volume', category: 'Beauty', kind: 'chips', unit: 'ml', variant: true, values: ['30 ml', '50 ml', '100 ml', '150 ml', '200 ml', '250 ml', '400 ml', '500 ml'] },
  { code: 'claims', name: 'Free from', category: 'Beauty', kind: 'chips', values: ['Paraben-free', 'Sulphate-free', 'Cruelty-free', 'Vegan', 'Natural / Ayurvedic', 'Dermatologically tested', 'Fragrance-free', 'Alcohol-free'] },

  // ── Sports ──
  { code: 'sport', name: 'Sport', category: 'Sports', kind: 'chips', values: ['Cricket', 'Football', 'Badminton', 'Tennis', 'Yoga', 'Gym', 'Running', 'Cycling', 'Swimming', 'Skating'] },
  { code: 'sports_type', name: 'Product type', category: 'Sports', kind: 'chips', values: ['Equipment', 'Sportswear', 'Sports shoes', 'Fitness gear', 'Accessories', 'Outdoor'] },
  { code: 'sports_material', name: 'Material', category: 'Sports', kind: 'chips', values: ['Rubber', 'Leather', 'Synthetic', 'Steel', 'Foam', 'Nylon', 'Polyester', 'Wood'] },
  { code: 'sports_size', name: 'Size', category: 'Sports', kind: 'chips', variant: true, values: ['S', 'M', 'L', 'XL', 'XXL', 'Free size', 'Junior', 'Senior'] },
];

// ── Reading the demo products' source data ───────────────────────────────────

const has = (text, word) => new RegExp(`(^|[^a-z])${word}([^a-z]|$)`, 'i').test(text);
const firstOf = (text, map) => {
  for (const [word, value] of map) if (has(text, word)) return value;
  return null;
};
const allOf = (text, map) => [...new Set(map.filter(([word]) => has(text, word)).map(([, v]) => v))];

const DEPARTMENT = { 'mens-shirts': 'Men', 'mens-shoes': 'Men', 'mens-watches': 'Men', 'womens-dresses': 'Women', tops: 'Women', 'womens-shoes': 'Women', 'womens-bags': 'Women', 'womens-watches': 'Women', 'womens-jewellery': 'Women', sunglasses: 'Unisex' };
const SHOE_TYPES = [['slipper', 'Slippers'], ['sandal', 'Sandals'], ['heel', 'Formal shoes'], ['sneaker', 'Sneakers'], ['trainer', 'Sneakers'], ['cleat', 'Sports shoes'], ['running', 'Sports shoes'], ['boot', 'Boots']];
const COLOUR_WORDS = [['black', 'Black'], ['white', 'White'], ['grey', 'Grey'], ['gray', 'Grey'], ['navy', 'Navy'], ['blue', 'Blue'], ['red', 'Red'], ['pink', 'Pink'], ['maroon', 'Maroon'], ['green', 'Green'], ['olive', 'Olive'], ['yellow', 'Yellow'], ['orange', 'Orange'], ['brown', 'Brown'], ['beige', 'Beige'], ['purple', 'Purple'], ['gold(en)?', 'Gold'], ['silver', 'Silver']];
const FABRIC_WORDS = [['leather', 'Leather'], ['denim', 'Denim'], ['linen', 'Linen'], ['silk', 'Silk'], ['wool', 'Wool'], ['polyester', 'Polyester'], ['nylon', 'Nylon'], ['canvas', 'Canvas'], ['stainless steel', 'Stainless steel'], ['metal', 'Metal'], ['cotton', 'Cotton'], ['fleece', 'Fleece'], ['synthetic', 'Synthetic']];
const HOME_MATERIAL_WORDS = [['stainless steel', 'Stainless steel'], ['wood(en)?', 'Wood'], ['metal', 'Metal'], ['glass', 'Glass'], ['ceramic', 'Ceramic'], ['plastic', 'Plastic'], ['bamboo', 'Bamboo'], ['marble', 'Marble'], ['silicone', 'Silicone'], ['non-stick', 'Non-stick'], ['cast iron', 'Cast iron'], ['cotton', 'Cotton'], ['fabric', 'Fabric']];
const HOME_TYPES = [['sofa', 'Sofa'], ['bed', 'Bed'], ['table', 'Table'], ['chair', 'Chair'], ['wardrobe', 'Wardrobe'], ['shelf', 'Shelf'], ['mattress', 'Mattress'], ['pan', 'Cookware'], ['pot', 'Cookware'], ['cookware', 'Cookware'], ['kettle', 'Kitchen appliance'], ['knife', 'Cutlery'], ['spoon', 'Cutlery'], ['fork', 'Cutlery'], ['spatula', 'Cutlery'], ['plate', 'Dinnerware'], ['bowl', 'Dinnerware'], ['mug', 'Dinnerware'], ['glass', 'Dinnerware'], ['tray', 'Dinnerware'], ['lamp', 'Lighting'], ['light', 'Lighting'], ['vase', 'Showpiece & vase'], ['plant', 'Showpiece & vase'], ['decor', 'Wall decor'], ['wall', 'Wall decor'], ['cushion', 'Cushion'], ['pillow', 'Pillow'], ['rug', 'Rug'], ['curtain', 'Curtains'], ['storage', 'Storage'], ['box', 'Storage']];
const ROOM_WORDS = [['bedroom', 'Bedroom'], ['bed', 'Bedroom'], ['living', 'Living room'], ['sofa', 'Living room'], ['dining', 'Dining'], ['kitchen', 'Kitchen'], ['bath', 'Bathroom'], ['office', 'Study'], ['desk', 'Study']];
const BEAUTY_TYPES = [['mascara', 'Mascara'], ['lipstick', 'Lipstick'], ['eyeshadow', 'Eyeshadow'], ['foundation', 'Foundation'], ['powder', 'Face powder'], ['nail polish', 'Nail polish'], ['perfume', 'Perfume'], ['eau de', 'Perfume'], ['deodorant', 'Deodorant'], ['shampoo', 'Shampoo'], ['conditioner', 'Conditioner'], ['hair oil', 'Hair oil'], ['hand soap', 'Hand wash'], ['hand wash', 'Hand wash'], ['body wash', 'Body wash'], ['lotion', 'Body lotion'], ['soap', 'Soap'], ['face wash', 'Face wash'], ['sunscreen', 'Sunscreen'], ['serum', 'Serum'], ['moisturi[sz]er', 'Moisturiser'], ['mask', 'Face mask']];
const FRAGRANCE_FAMILY = [['floral', 'Floral'], ['rose', 'Floral'], ['jasmine', 'Floral'], ['tuberose', 'Floral'], ['woody', 'Woody'], ['sandalwood', 'Woody'], ['cedar', 'Woody'], ['citrus', 'Citrus'], ['grapefruit', 'Citrus'], ['lemon', 'Citrus'], ['bergamot', 'Citrus'], ['fresh', 'Fresh'], ['clean', 'Fresh'], ['aquatic', 'Aquatic'], ['marine', 'Aquatic'], ['fruity', 'Fruity'], ['mango', 'Fruity'], ['apple', 'Fruity'], ['musk', 'Musky'], ['oriental', 'Oriental'], ['amber', 'Oriental'], ['vanilla', 'Oriental']];
const GADGET_ACCESSORY_TYPES = [['power ?bank', 'Power bank'], ['charger', 'Charger'], ['cable', 'Cable'], ['case', 'Case & cover'], ['cover', 'Case & cover'], ['screen protector', 'Screen guard'], ['earbuds', 'Earphones'], ['airpods', 'Earphones'], ['earphone', 'Earphones'], ['headphone', 'Headphones'], ['speaker', 'Speaker'], ['watch', 'Smartwatch'], ['keyboard', 'Keyboard'], ['mouse', 'Mouse'], ['monitor', 'Monitor'], ['camera', 'Camera']];

function warrantyValue(text) {
  const t = (text || '').toLowerCase();
  if (!t || t.includes('no warranty')) return t ? 'No warranty' : null;
  if (t.includes('lifetime')) return 'Lifetime';
  const m = /(\d+)\s*(week|month|year)/.exec(t);
  if (!m) return null;
  const n = Number(m[1]);
  if (m[2] === 'week' || m[2] === 'month') return 'Up to 6 months';
  if (n === 1) return '1 year';
  if (n === 2) return '2 years';
  return '3 years or more';
}

/** attribute code → values for one DummyJSON product. */
function factsFor(p, demoSizes) {
  const title = p.title || '';
  const text = `${title}. ${p.description || ''}`;
  const facts = {};
  const set = (code, ...values) => {
    const list = values.flat().filter(Boolean);
    if (list.length) facts[code] = [...new Set([...(facts[code] ?? []), ...list])];
  };
  const c = p.category;

  set('colour', allOf(title, COLOUR_WORDS).length ? allOf(title, COLOUR_WORDS) : [firstOf(text, COLOUR_WORDS)]);
  set('warranty', warrantyValue(p.warrantyInformation));

  if (DEPARTMENT[c]) {
    set('department', DEPARTMENT[c]);
    set('fabric', allOf(text, FABRIC_WORDS));
    set('pattern', firstOf(text, [['plaid', 'Checked'], ['check', 'Checked'], ['stripe', 'Striped'], ['floral', 'Floral'], ['graphic', 'Graphic'], ['logo', 'Graphic'], ['print', 'Printed'], ['embroider', 'Embroidered'], ['solid', 'Solid']]));
    set('occasion', allOf(text, [['casual', 'Casual'], ['formal', 'Formal'], ['party', 'Party'], ['festive', 'Festive'], ['office', 'Workwear'], ['sport', 'Sports'], ['baseball', 'Sports']]));
    set('season', firstOf(text, [['summer', 'Summer'], ['warm days', 'Summer'], ['winter', 'Winter'], ['monsoon', 'Monsoon']]));
    set('style', firstOf(text, [['premium', 'Premium'], ['luxur', 'Premium'], ['prestigious', 'Premium'], ['streetwear', 'Streetwear'], ['minimal', 'Minimal'], ['trendy', 'Trendy'], ['classic', 'Classic'], ['timeless', 'Classic'], ['basic', 'Basic']]));
    const apparel = c === 'mens-shirts' || c === 'womens-dresses' || c === 'tops';
    const shoes = c === 'mens-shoes' || c === 'womens-shoes';
    if (c === 'mens-shirts') set('fashion_type', has(title, 't-?shirt') ? 'T-shirt' : 'Shirt');
    if (c === 'womens-dresses') set('fashion_type', 'Dress');
    if (c === 'tops') set('fashion_type', 'Top');
    if (shoes) set('fashion_type', firstOf(text, SHOE_TYPES) ?? 'Casual shoes');
    if (c === 'mens-watches' || c === 'womens-watches') set('fashion_type', 'Watch');
    if (c === 'womens-bags') set('fashion_type', 'Bag');
    if (c === 'womens-jewellery') set('fashion_type', 'Jewellery');
    if (c === 'sunglasses') set('fashion_type', 'Sunglasses');
    if (apparel) {
      set('sleeve', firstOf(text, [['sleeveless', 'Sleeveless'], ['short sleeve', 'Half sleeve'], ['half sleeve', 'Half sleeve'], ['long sleeve', 'Full sleeve'], ['full sleeve', 'Full sleeve']]));
      set('fit', firstOf(text, [['slim', 'Slim'], ['oversized', 'Oversized'], ['relaxed', 'Relaxed'], ['loose', 'Loose'], ['regular', 'Regular'], ['comfortable fit', 'Regular']]));
      set('neck', firstOf(text, [['v-neck', 'V-neck'], ['crew', 'Crew neck'], ['round neck', 'Round neck'], ['polo', 'Polo collar'], ['hood', 'Hooded'], ['collar', 'Spread collar']]));
      if (demoSizes) set('size', 'S', 'M', 'L', 'XL');
    }
    if (shoes && demoSizes) set('shoe_size', 'UK 6', 'UK 7', 'UK 8', 'UK 9', 'UK 10');
    if (c.endsWith('watches')) {
      set('strap', firstOf(text, [['leather', 'Leather strap'], ['steel', 'Metal strap'], ['metal', 'Metal strap'], ['silicone', 'Silicone strap'], ['fabric', 'Fabric strap']]));
      set('dial', firstOf(text, [['round', 'Round'], ['square', 'Square'], ['rectang', 'Rectangular']]));
    }
    if (c === 'sunglasses') set('frame', firstOf(text, [['aviator', 'Aviator'], ['wayfarer', 'Wayfarer'], ['round', 'Round frame'], ['square', 'Square frame'], ['cat eye', 'Cat eye']]));
  }

  if (['smartphones', 'laptops', 'tablets', 'mobile-accessories'].includes(c)) {
    if (c === 'smartphones') set('gadget_type', 'Smartphone');
    if (c === 'laptops') set('gadget_type', 'Laptop');
    if (c === 'tablets') set('gadget_type', 'Tablet');
    if (c === 'mobile-accessories') set('gadget_type', firstOf(title, GADGET_ACCESSORY_TYPES));
    const apple = has(text, 'apple') || has(text, 'iphone') || has(text, 'ipad') || has(text, 'macbook');
    if (c === 'smartphones') set('os', apple ? 'iOS' : 'Android');
    if (c === 'tablets') set('os', apple ? 'iOS' : 'Android');
    if (c === 'laptops') set('os', apple ? 'macOS' : 'Windows');
    set('connectivity', allOf(text, [['5g', '5G'], ['4g', '4G'], ['wi-?fi', 'Wi-Fi'], ['bluetooth', 'Bluetooth'], ['nfc', 'NFC'], ['wired', 'Wired']]));
    set('features', allOf(text, [['fast charg', 'Fast charging'], ['wireless charg', 'Wireless charging'], ['water[- ]resist', 'Water resistant'], ['dual sim', 'Dual SIM'], ['fingerprint', 'Fingerprint'], ['face ?id', 'Face unlock'], ['noise[- ]cancel', 'Noise cancelling'], ['touch ?screen', 'Touchscreen'], ['backlit', 'Backlit keyboard']]));
    const ram = /(\d+)\s?GB\s?(of )?RAM/i.exec(text);
    if (ram) set('ram', `${ram[1]} GB`);
    const storage = /(\d+)\s?(GB|TB)\s?(of )?(storage|SSD|internal)/i.exec(text);
    if (storage) set('storage', `${storage[1]} ${storage[2].toUpperCase()}`);
    const screen = /(\d+(?:\.\d+)?)[- ]inch/i.exec(text);
    if (screen) set('screen', screen[1]);
    set('processor', firstOf(text, [['intel core i3', 'Intel Core i3'], ['intel core i5', 'Intel Core i5'], ['intel core i7', 'Intel Core i7'], ['intel core i9', 'Intel Core i9'], ['ryzen 3', 'AMD Ryzen 3'], ['ryzen 5', 'AMD Ryzen 5'], ['ryzen 7', 'AMD Ryzen 7'], ['m1', 'Apple M1'], ['m2', 'Apple M2'], ['m3', 'Apple M3']]));
    set('condition', 'New');
  }

  if (c === 'groceries') {
    set('dietary', allOf(text, [['organic', 'Organic'], ['vegan', 'Vegan'], ['gluten[- ]free', 'Gluten-free'], ['sugar[- ]free', 'Sugar-free'], ['protein', 'High protein']]));
    set('form', firstOf(text, [['frozen', 'Frozen'], ['fresh', 'Fresh'], ['dried', 'Dried'], ['powder', 'Packaged'], ['canned', 'Packaged']]));
  }

  if (['furniture', 'home-decoration', 'kitchen-accessories'].includes(c)) {
    set('home_type', firstOf(title, HOME_TYPES));
    set('home_material', allOf(text, HOME_MATERIAL_WORDS));
    set('room', c === 'kitchen-accessories' ? 'Kitchen' : firstOf(text, ROOM_WORDS));
    if (c === 'furniture') set('assembly', firstOf(text, [['assembl', 'DIY assembly']]));
  }

  if (['beauty', 'skin-care', 'fragrances'].includes(c)) {
    set('beauty_type', firstOf(title, BEAUTY_TYPES) ?? firstOf(text, BEAUTY_TYPES));
    set('for', firstOf(text, [['unisex', 'Unisex'], ['for men', 'Men'], ['men\'s', 'Men'], ['masculine', 'Men'], ['for women', 'Women'], ['feminine', 'Women'], ['for her', 'Women']]));
    set('formulation', firstOf(text, [['cream', 'Cream'], ['gel', 'Gel'], ['powder', 'Powder'], ['oil', 'Oil'], ['foam', 'Foam'], ['spray', 'Spray'], ['stick', 'Stick'], ['bar', 'Bar'], ['sheet', 'Sheet'], ['liquid', 'Liquid'], ['lotion', 'Liquid'], ['wash', 'Liquid']]));
    set('claims', allOf(text, [['paraben[- ]free', 'Paraben-free'], ['sulphate[- ]free', 'Sulphate-free'], ['sulfate[- ]free', 'Sulphate-free'], ['cruelty[- ]free', 'Cruelty-free'], ['vegan', 'Vegan'], ['natural', 'Natural / Ayurvedic'], ['dermatolog', 'Dermatologically tested'], ['fragrance[- ]free', 'Fragrance-free'], ['alcohol[- ]free', 'Alcohol-free']]));
    if (c === 'beauty') {
      set('finish', firstOf(text, [['matte', 'Matte'], ['gloss', 'Glossy'], ['satin', 'Satin'], ['shimmer', 'Shimmer'], ['natural', 'Natural']]));
      set('shade', firstOf(title, [['red', 'Red'], ['pink', 'Pink'], ['nude', 'Nude'], ['brown', 'Brown'], ['coral', 'Coral'], ['berry', 'Berry'], ['black', 'Black']]));
      delete facts.colour; // the shade is the colour of a lipstick
    }
    if (c === 'skin-care') set('skin_type', firstOf(text, [['dry skin', 'Dry'], ['oily', 'Oily'], ['sensitive', 'Sensitive'], ['combination', 'Combination'], ['all skin', 'All skin types']]));
    if (c === 'fragrances') {
      set('fragrance_family', allOf(text, FRAGRANCE_FAMILY).slice(0, 2));
      set('fragrance_strength', firstOf(text, [['eau de parfum', 'Eau de Parfum'], ['eau de toilette', 'Eau de Toilette'], ['eau de cologne', 'Eau de Cologne'], ['eau de', 'Eau de Parfum'], ['body mist', 'Body mist']]));
    }
    const ml = /(\d+)\s?ml/i.exec(text);
    if (ml) set('volume', `${ml[1]} ml`);
  }

  return facts;
}

// ── Writing ──────────────────────────────────────────────────────────────────

async function upsertRegistry(client) {
  const { rows: categories } = await client.query('SELECT id, name FROM categories');
  const categoryId = (name) => (name == null ? null : categories.find((c) => c.name.toLowerCase() === name.toLowerCase())?.id ?? null);
  const valueIds = new Map(); // `${code}|${value}` → id
  let order = 0;
  for (const a of REGISTRY) {
    order += 10;
    if (a.category && categoryId(a.category) == null) {
      console.log(`  skipped ${a.code}: no category named ${a.category}`);
      continue;
    }
    const { rows } = await client.query(
      `INSERT INTO product_attributes (name, code, category_id, input_type, is_variant_defining, sort_order, is_filter, filter_kind, unit, subcategories)
       VALUES ($1, $2, $3, 'select', $4, $5, true, $6, $7, $8)
       ON CONFLICT (code) DO UPDATE SET
         name = EXCLUDED.name, category_id = EXCLUDED.category_id, is_variant_defining = EXCLUDED.is_variant_defining,
         sort_order = EXCLUDED.sort_order, is_filter = true, filter_kind = EXCLUDED.filter_kind, unit = EXCLUDED.unit,
         subcategories = EXCLUDED.subcategories, is_active = true
       RETURNING id`,
      [a.name, a.code, categoryId(a.category), a.variant === true, order, a.kind, a.unit ?? null, a.subcategories ?? null]
    );
    const attributeId = rows[0].id;
    let vOrder = 0;
    for (const entry of a.values) {
      vOrder += 10;
      const [value, hex] = Array.isArray(entry) ? entry : [entry, null];
      const { rows: v } = await client.query(
        `INSERT INTO attribute_values (attribute_id, value, sort_order, color_hex) VALUES ($1, $2, $3, $4)
         ON CONFLICT (attribute_id, value) DO UPDATE SET sort_order = EXCLUDED.sort_order, color_hex = COALESCE(EXCLUDED.color_hex, attribute_values.color_hex)
         RETURNING id`,
        [attributeId, value, vOrder, hex]
      );
      valueIds.set(`${a.code}|${value}`, v[0].id);
    }
  }
  // The pre-existing Grocery "Pack size" (demo_pack) is a filter too.
  await client.query(`UPDATE product_attributes SET is_filter = true, filter_kind = 'chips' WHERE code = 'demo_pack'`);
  return { valueIds, attributeIdOf: async (code) => (await client.query('SELECT id FROM product_attributes WHERE code = $1', [code])).rows[0]?.id };
}

async function tagDemoProducts(client, valueIds, demoSizes) {
  const res = await fetch('https://dummyjson.com/products?limit=0');
  const { products } = await res.json();
  const { rows: demo } = await client.query(`SELECT id, sku FROM products WHERE sku LIKE 'DEMO-DJ-%'`);
  const bySku = new Map(demo.map((r) => [r.sku, r.id]));
  let tagged = 0, values = 0;
  const perAttribute = {};
  for (const p of products) {
    const productId = bySku.get(`DEMO-DJ-${p.id}`);
    if (!productId) continue;
    const facts = factsFor(p, demoSizes);
    const ids = [];
    for (const [code, list] of Object.entries(facts)) {
      for (const value of list) {
        let id = valueIds.get(`${code}|${value}`);
        if (!id) {
          // A value the registry didn't list (a 6.8-inch screen): add it.
          const { rows: attr } = await client.query('SELECT id FROM product_attributes WHERE code = $1', [code]);
          if (!attr[0]) continue;
          const { rows: v } = await client.query(
            `INSERT INTO attribute_values (attribute_id, value, sort_order) VALUES ($1, $2, 1000)
             ON CONFLICT (attribute_id, value) DO UPDATE SET value = EXCLUDED.value RETURNING id`,
            [attr[0].id, value]
          );
          id = v[0].id;
          valueIds.set(`${code}|${value}`, id);
        }
        ids.push(id);
        perAttribute[code] = (perAttribute[code] ?? 0) + 1;
      }
    }
    await client.query('DELETE FROM product_attribute_values WHERE product_id = $1', [productId]);
    for (const id of new Set(ids)) {
      await client.query('INSERT INTO product_attribute_values (product_id, attribute_value_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [productId, id]);
    }
    if (ids.length) tagged++;
    values += ids.length;
  }
  return { tagged, values, perAttribute };
}

async function main() {
  const demoSizes = process.env.DEMO_SIZES === '1';
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { valueIds } = await upsertRegistry(client);
    console.log(`Registry: ${REGISTRY.length} attributes, ${valueIds.size} values.`);
    const result = await tagDemoProducts(client, valueIds, demoSizes);
    await client.query('COMMIT');
    console.log(`Demo products tagged: ${result.tagged} (${result.values} values${demoSizes ? ', demo sizes included' : ''}).`);
    for (const [code, n] of Object.entries(result.perAttribute).sort()) console.log(`  ${code}: ${n}`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
