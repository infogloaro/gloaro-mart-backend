/**
 * Gloaro Mart's category taxonomy (WORK_PLAN CT): 29 categories A–Z, each
 * with its sub-categories and the filters (product attributes) a shopper sees
 * there, modelled on Amazon.in and Flipkart and approved by the owner on
 * 2026-11-04. Product types (Level 3) are the "Product type" filter of each
 * category, so a new type is a new value, not a new category.
 *
 * Read by scripts/seed-category-taxonomy.js. Attribute `cats` lists every
 * category the filter applies to; the first is stored as category_id, all of
 * them in category_ids. `subs` narrows a filter to some sub-categories (the
 * app hides it elsewhere). Codes are stable ids: existing codes from
 * seed-filter-attributes.js are kept so values already set stay valid.
 */

const CATEGORIES = [
  { name: 'Appliances', icon: 'appliances', subs: ['Televisions', 'Air conditioners', 'Refrigerators', 'Washing machines', 'Microwave ovens', 'Water purifiers', 'Fans & air coolers', 'Geysers & water heaters', 'Chimneys', 'Small kitchen appliances', 'Irons & garment care', 'Vacuum cleaners', 'Inverters & batteries', 'Sewing machines'] },
  { name: 'Automotive', icon: 'automotive', subs: ['Car accessories', 'Bike accessories', 'Helmets & riding gear', 'Car electronics', 'Engine oil & fluids', 'Spare parts', 'Tyres', 'Car & bike care', 'Vehicle tools'] },
  { name: 'Baby Care', icon: 'baby', subs: ['Diapers & wipes', 'Baby food & formula', 'Baby bath & skin care', 'Feeding & nursing', 'Baby gear', 'Nursery', 'Baby health & safety', 'Maternity care'] },
  { name: 'Bags, Luggage & Travel', icon: 'bags', subs: ['Backpacks', 'Suitcases & trolleys', 'Laptop bags', 'Duffel & gym bags', 'School bags', 'Travel accessories'] },
  { name: 'Beauty & Grooming', icon: 'beauty', subs: ['Makeup', 'Skin care', 'Hair care', 'Fragrances', 'Bath & body', "Men's grooming", 'Grooming appliances', 'Nail care', 'Beauty tools', 'Oral care', 'Feminine hygiene'] },
  { name: 'Books', icon: 'books', subs: ['Fiction', 'Non-fiction', 'School & college textbooks', 'Competitive exams', "Children's books", 'Tamil & regional language', 'Comics', 'Religious & spiritual'] },
  { name: 'Computers & Accessories', icon: 'computers', subs: ['Laptops', 'Tablets', 'Desktops', 'Monitors', 'Printers & ink', 'Keyboards & mice', 'Storage devices', 'Networking', 'Computer components', 'Software'] },
  { name: 'Electronics', icon: 'electronics', subs: ['Headphones & earphones', 'Speakers', 'Home theatre & soundbars', 'Cameras & accessories', 'Smartwatches & fitness bands', 'Smart home', 'Projectors', 'Batteries & cells'] },
  { name: 'Footwear', icon: 'footwear', subs: ["Men's footwear", "Women's footwear", "Kids' footwear", 'Socks & shoe care'] },
  { name: 'Gaming', icon: 'gaming', subs: ['Consoles', 'Video games', 'Gaming accessories'] },
  { name: 'Garden & Outdoors', icon: 'garden', subs: ['Plants & seeds', 'Pots & planters', 'Gardening tools', 'Soil & fertilisers', 'Outdoor furniture'] },
  { name: 'Grocery', icon: 'grocery', subs: ['Fruits & vegetables', 'Dairy, bread & eggs', 'Meat, fish & chicken', 'Atta, rice & dals', 'Oils & ghee', 'Masalas & spices', 'Dry fruits & nuts', 'Snacks & namkeen', 'Biscuits & cookies', 'Breakfast & cereals', 'Tea, coffee & drinks', 'Sweets & chocolates', 'Instant & ready to eat', 'Sauces, pickles & spreads', 'Frozen food', 'Baking', 'Organic & health food'] },
  { name: 'Health & Pharmacy', icon: 'pharmacy', subs: ['OTC medicines', 'Prescription medicines', 'Vitamins & supplements', 'Health devices', 'First aid', 'Ayurveda & homeopathy', 'Elderly & mobility care', 'Sexual wellness', 'Masks & sanitisers'] },
  { name: 'Home & Furniture', icon: 'home', subs: ['Furniture', 'Furnishing', 'Home decor', 'Lighting', 'Storage & organisers', 'Bath', 'Mattresses & pillows'] },
  { name: 'Home Improvement & Tools', icon: 'hardware', subs: ['Hand tools', 'Power tools', 'Electricals', 'Bulbs & lights', 'Plumbing & sanitary', 'Paints & wall care', 'Hardware & fasteners', 'Locks & security', 'Safety gear'] },
  { name: 'Household Supplies', icon: 'household', subs: ['Detergents & laundry', 'Dishwash', 'Floor & surface cleaners', 'Toilet & bathroom cleaners', 'Fresheners', 'Pest control', 'Garbage bags', 'Tissues & napkins', 'Brooms & mops'] },
  { name: "Kids' Fashion", icon: 'kids', subs: ['Boys clothing', 'Girls clothing', 'Infant wear', 'School uniforms', 'Kids ethnic wear'] },
  { name: 'Kitchen & Dining', icon: 'kitchen', subs: ['Cookware', 'Pressure cookers', 'Gas stoves', 'Kitchen tools', 'Cutlery', 'Dinnerware', 'Serveware', 'Glassware & drinkware', 'Containers & storage', 'Bottles & flasks', 'Lunch boxes'] },
  { name: "Men's Fashion", icon: 'men', subs: ['T-shirts & polos', 'Shirts', 'Jeans', 'Trousers', 'Shorts & track pants', 'Ethnic wear', 'Innerwear', 'Sleep & lounge wear', 'Winter wear', 'Sportswear', 'Suits & blazers', 'Raincoats'] },
  { name: 'Mobiles & Accessories', icon: 'devices', subs: ['Smartphones', 'Feature phones', 'Cases & covers', 'Screen guards', 'Chargers & cables', 'Power banks', 'Memory cards', 'Mobile holders & stands'] },
  { name: 'Musical Instruments', icon: 'music', subs: ['Guitars', 'Keyboards & pianos', 'Percussion', 'Wind instruments', 'Microphones & studio', 'Instrument accessories'] },
  { name: 'Pet Supplies', icon: 'pets', subs: ['Dog', 'Cat', 'Fish & aquarium', 'Birds', 'Pet food', 'Pet grooming', 'Pet toys & accessories'] },
  { name: 'Pooja & Festive', icon: 'pooja', subs: ['Pooja items', 'Idols & frames', 'Festive decor', 'Gift hampers', 'Festival specials'] },
  { name: 'Restaurant & Food', icon: 'food', subs: ['Meals', 'Biryani & rice', 'Tiffin', 'Fast food & snacks', 'Sweets', 'Cakes & desserts', 'Juices & beverages'] },
  { name: 'Sports & Fitness', icon: 'sports', subs: ['Cricket', 'Football', 'Badminton', 'Tennis & table tennis', 'Basketball & volleyball', 'Gym equipment', 'Yoga', 'Cycling', 'Swimming', 'Running', 'Camping & hiking', 'Sports nutrition', 'Other sports'] },
  { name: 'Stationery & Office', icon: 'stationery', subs: ['Notebooks & paper', 'Pens & writing', 'School supplies', 'Art & craft', 'Office supplies', 'Calculators', 'Printing paper'] },
  { name: 'Toys & Games', icon: 'toys', subs: ['Soft toys', 'Dolls & doll houses', 'Action figures', 'Educational & STEM', 'Board games & puzzles', 'Remote control toys', 'Outdoor play', 'Ride-ons'] },
  { name: 'Watches, Eyewear & Jewellery', icon: 'watches', subs: ["Men's watches", "Women's watches", 'Sunglasses', 'Spectacle frames', 'Gold jewellery', 'Silver jewellery', 'Fashion jewellery', 'Belts & wallets', 'Handbags & clutches'] },
  { name: "Women's Fashion", icon: 'fashion', subs: ['Sarees', 'Kurtas & kurtis', 'Salwar suits & dress material', 'Lehengas', 'Tops & tees', 'Dresses', 'Jeans & trousers', 'Leggings', 'Innerwear & lingerie', 'Nightwear', 'Winter wear', 'Sportswear'] },
];

/** Existing rows renamed in place (keeps their id and uploaded picture). */
const RENAMES = [
  ['Gadgets', 'Mobiles & Accessories'],
  ['Fashion', "Women's Fashion"],
  ['Home', 'Home & Furniture'],
  ['Beauty', 'Beauty & Grooming'],
  ['Sports', 'Sports & Fitness'],
];

const COLOURS = [
  ['Black', '#111111'], ['White', '#FFFFFF'], ['Grey', '#9E9E9E'], ['Navy', '#1F2A5A'], ['Blue', '#0D4FD1'],
  ['Red', '#D32F2F'], ['Pink', '#EC407A'], ['Maroon', '#7B1F2B'], ['Green', '#2E7D32'], ['Olive', '#6B7A2A'],
  ['Yellow', '#FBC02D'], ['Orange', '#FB8C00'], ['Brown', '#6D4C41'], ['Beige', '#D7C4A3'], ['Purple', '#7E57C2'],
  ['Gold', '#C9A227'], ['Silver', '#B0BEC5'], ['Multicolour', null],
];

const MEN = "Men's Fashion";
const WOMEN = "Women's Fashion";
const KIDS = "Kids' Fashion";
const APPAREL = [MEN, WOMEN, KIDS];
const WATCHES = 'Watches, Eyewear & Jewellery';
const MOBILES = 'Mobiles & Accessories';
const COMPUTERS = 'Computers & Accessories';
const HOME = 'Home & Furniture';
const KITCHEN = 'Kitchen & Dining';
const TOOLS = 'Home Improvement & Tools';
const BEAUTY = 'Beauty & Grooming';
const SPORTS = 'Sports & Fitness';
const AGE_KIDS = ['0–6 months', '6–12 months', '1–2 years', '2–4 years', '4–6 years', '6–8 years', '8–10 years', '10–12 years', '12–14 years', '14–16 years'];
const VEG = [['Veg', '#2E7D32'], ['Non-veg', '#C62828'], ['Egg', '#F9A825']];
const YES_NO = ['Yes', 'No'];

/**
 * One filter each. kind: chips | swatch | range | toggle. variant: true when it
 * makes a different sellable thing (size), so shops build variants from it.
 */
const ATTRIBUTES = [
  // ── Every category ──
  { code: 'colour', name: 'Colour', cats: null, kind: 'swatch', variant: true, values: COLOURS },
  { code: 'warranty', name: 'Warranty', cats: null, kind: 'chips', values: ['No warranty', 'Up to 6 months', '1 year', '2 years', '3 years or more', 'Lifetime'] },
  { code: 'origin', name: 'Country of origin', cats: null, kind: 'chips', values: ['India', 'Imported'] },

  // ── 1 Appliances ──
  { code: 'ptype_appliances', name: 'Product type', cats: ['Appliances'], kind: 'chips', values: ['LED TV', 'Smart TV', 'Split AC', 'Window AC', 'Portable AC', 'Refrigerator', 'Washing machine', 'Microwave oven', 'OTG oven', 'Water purifier', 'Ceiling fan', 'Table fan', 'Pedestal fan', 'Air cooler', 'Geyser', 'Chimney', 'Mixer grinder', 'Juicer', 'Induction cooktop', 'Air fryer', 'Electric kettle', 'Toaster', 'Rice cooker', 'Iron', 'Vacuum cleaner', 'Inverter', 'Inverter battery', 'Sewing machine'] },
  { code: 'energy_rating', name: 'Energy rating', cats: ['Appliances'], kind: 'chips', values: ['1 star', '2 star', '3 star', '4 star', '5 star'] },
  { code: 'capacity', name: 'Capacity', cats: [KITCHEN, 'Appliances'], kind: 'chips', values: ['Under 1 L', '1 – 2 L', '2 – 5 L', '5 L or more', '1 piece', 'Set of 2', 'Set of 4', 'Set of 6'] },
  { code: 'power', name: 'Power', cats: ['Appliances', KITCHEN], kind: 'chips', unit: 'W', values: ['Under 500 W', '500 – 1,000 W', '1,000 – 1,500 W', '1,500 W or more'] },
  { code: 'installation', name: 'Installation', cats: ['Appliances'], kind: 'chips', values: ['Free installation', 'Paid installation', 'No installation needed'] },
  { code: 'tv_size', name: 'Screen size', cats: ['Appliances'], subs: ['Televisions'], kind: 'chips', unit: 'inch', values: ['24"', '32"', '40"', '43"', '50"', '55"', '65"', '75" or more'] },
  { code: 'tv_resolution', name: 'Resolution', cats: ['Appliances', 'Electronics'], subs: ['Televisions', 'Projectors'], kind: 'chips', values: ['HD Ready', 'Full HD', '4K Ultra HD', '8K'] },
  { code: 'tv_display', name: 'Display', cats: ['Appliances'], subs: ['Televisions'], kind: 'chips', values: ['LED', 'QLED', 'OLED', 'Mini LED'] },
  { code: 'tv_os', name: 'Smart TV OS', cats: ['Appliances'], subs: ['Televisions'], kind: 'chips', values: ['Google TV / Android TV', 'webOS', 'Tizen', 'Fire TV', 'Not a smart TV'] },
  { code: 'ac_tonnage', name: 'Tonnage', cats: ['Appliances'], subs: ['Air conditioners'], kind: 'chips', values: ['0.75 ton', '1 ton', '1.5 ton', '2 ton or more'] },
  { code: 'ac_type', name: 'AC type', cats: ['Appliances'], subs: ['Air conditioners'], kind: 'chips', values: ['Split', 'Window', 'Portable'] },
  { code: 'inverter', name: 'Inverter technology', cats: ['Appliances'], subs: ['Air conditioners', 'Refrigerators', 'Washing machines'], kind: 'toggle', values: YES_NO },
  { code: 'fridge_door', name: 'Door type', cats: ['Appliances'], subs: ['Refrigerators'], kind: 'chips', values: ['Single door', 'Double door', 'Triple door', 'Side-by-side', 'French door'] },
  { code: 'fridge_capacity', name: 'Fridge capacity', cats: ['Appliances'], subs: ['Refrigerators'], kind: 'chips', unit: 'L', values: ['Under 200 L', '200 – 300 L', '300 – 450 L', '450 L or more'] },
  { code: 'wm_load', name: 'Loading', cats: ['Appliances'], subs: ['Washing machines'], kind: 'chips', values: ['Front load', 'Top load'] },
  { code: 'wm_function', name: 'Function', cats: ['Appliances'], subs: ['Washing machines'], kind: 'chips', values: ['Fully automatic', 'Semi automatic'] },
  { code: 'wm_capacity', name: 'Wash capacity', cats: ['Appliances'], subs: ['Washing machines'], kind: 'chips', unit: 'kg', values: ['Under 6 kg', '6 – 7 kg', '7 – 8 kg', '8 kg or more'] },
  { code: 'mixer_jars', name: 'Number of jars', cats: ['Appliances'], subs: ['Small kitchen appliances'], kind: 'chips', values: ['1 jar', '2 jars', '3 jars', '4 jars or more'] },
  { code: 'purifier_tech', name: 'Purification', cats: ['Appliances'], subs: ['Water purifiers'], kind: 'chips', values: ['RO', 'UV', 'UF', 'RO + UV', 'RO + UV + UF', 'Gravity'] },
  { code: 'fan_type', name: 'Fan type', cats: ['Appliances'], subs: ['Fans & air coolers'], kind: 'chips', values: ['Ceiling', 'Table', 'Pedestal', 'Wall', 'Exhaust', 'Tower', 'Air cooler'] },
  { code: 'fan_sweep', name: 'Sweep size', cats: ['Appliances'], subs: ['Fans & air coolers'], kind: 'chips', unit: 'mm', values: ['600 mm', '900 mm', '1200 mm', '1400 mm'] },
  { code: 'bldc', name: 'BLDC motor', cats: ['Appliances'], subs: ['Fans & air coolers'], kind: 'toggle', values: YES_NO },

  // ── 2 Automotive ──
  { code: 'ptype_auto', name: 'Product type', cats: ['Automotive'], kind: 'chips', values: ['Seat cover', 'Floor mat', 'Car charger', 'Phone holder', 'Dash cam', 'Car stereo', 'Car perfume', 'Helmet', 'Riding gloves', 'Riding jacket', 'Engine oil', 'Coolant', 'Brake pads', 'Spark plug', 'Air filter', 'Tyre', 'Car wash shampoo', 'Polish & wax', 'Tyre inflator', 'Jump starter', 'Cover'] },
  { code: 'vehicle_type', name: 'Vehicle type', cats: ['Automotive'], kind: 'chips', values: ['Car', 'Bike', 'Scooter', 'Universal'] },
  { code: 'auto_material', name: 'Material', cats: ['Automotive'], kind: 'chips', values: ['Leather', 'Leatherette', 'Fabric', 'Rubber', 'Plastic', 'Metal', 'PU'] },
  { code: 'helmet_size', name: 'Helmet size', cats: ['Automotive'], subs: ['Helmets & riding gear'], kind: 'chips', variant: true, values: ['S (54–56 cm)', 'M (57–58 cm)', 'L (59–60 cm)', 'XL (61–62 cm)'] },
  { code: 'helmet_type', name: 'Helmet type', cats: ['Automotive'], subs: ['Helmets & riding gear'], kind: 'chips', values: ['Full face', 'Open face', 'Half face', 'Flip-up', 'Off-road'] },
  { code: 'isi', name: 'ISI certified', cats: ['Automotive', TOOLS], subs: ['Helmets & riding gear', 'Electricals'], kind: 'toggle', values: YES_NO },
  { code: 'oil_grade', name: 'Oil grade', cats: ['Automotive'], subs: ['Engine oil & fluids'], kind: 'chips', values: ['0W-20', '5W-30', '10W-30', '10W-40', '15W-40', '20W-40', '20W-50'] },
  { code: 'oil_base', name: 'Oil type', cats: ['Automotive'], subs: ['Engine oil & fluids'], kind: 'chips', values: ['Fully synthetic', 'Semi synthetic', 'Mineral'] },
  { code: 'oil_volume', name: 'Volume', cats: ['Automotive'], subs: ['Engine oil & fluids'], kind: 'chips', variant: true, values: ['500 ml', '800 ml', '900 ml', '1 L', '3 L', '3.5 L', '5 L'] },
  { code: 'tyre_size', name: 'Tyre size', cats: ['Automotive'], subs: ['Tyres'], kind: 'chips', variant: true, values: ['90/90-12', '90/100-10', '100/90-17', '120/80-17', '145/80 R12', '155/80 R13', '165/80 R14', '175/65 R14', '185/65 R15', '195/55 R16', '205/55 R16'] },
  { code: 'tubeless', name: 'Tubeless', cats: ['Automotive'], subs: ['Tyres'], kind: 'toggle', values: YES_NO },

  // ── 3 Baby Care ──
  { code: 'ptype_baby', name: 'Product type', cats: ['Baby Care'], kind: 'chips', values: ['Diapers', 'Wipes', 'Formula', 'Cereal', 'Baby oil', 'Baby lotion', 'Baby soap & wash', 'Baby powder', 'Feeding bottle', 'Sipper', 'Breast pump', 'Stroller', 'Carrier', 'Car seat', 'Cot & cradle', 'Baby bedding', 'Thermometer', 'Nasal aspirator', 'Maternity pads'] },
  { code: 'baby_age', name: 'Age', cats: ['Baby Care', 'Toys & Games'], kind: 'chips', values: ['0–6 months', '6–12 months', '1–2 years', '2–4 years', '3–5 years', '6–8 years', '9–12 years', '12+ years'] },
  { code: 'diaper_size', name: 'Diaper size', cats: ['Baby Care'], subs: ['Diapers & wipes'], kind: 'chips', variant: true, values: ['Newborn', 'XS', 'S', 'M', 'L', 'XL', 'XXL'] },
  { code: 'diaper_type', name: 'Diaper type', cats: ['Baby Care'], subs: ['Diapers & wipes'], kind: 'chips', values: ['Pant style', 'Tape style', 'Cloth diaper'] },
  { code: 'pack_count', name: 'Pack count', cats: ['Baby Care', 'Grocery', 'Household Supplies', 'Stationery & Office'], kind: 'chips', variant: true, values: ['1', '2', '3–5', '6–10', '11–30', '31–60', '61+'] },
  { code: 'baby_food_stage', name: 'Stage', cats: ['Baby Care'], subs: ['Baby food & formula'], kind: 'chips', values: ['Stage 1 (0–6 m)', 'Stage 2 (6–12 m)', 'Stage 3 (12–24 m)', 'Stage 4 (2+ y)'] },
  { code: 'flavour', name: 'Flavour', cats: ['Baby Care', 'Grocery', SPORTS, 'Pet Supplies', 'Health & Pharmacy'], kind: 'chips', values: ['Plain / unflavoured', 'Chocolate', 'Vanilla', 'Strawberry', 'Mango', 'Banana', 'Mixed fruit', 'Masala', 'Chicken', 'Fish', 'Mutton'] },
  { code: 'foldable', name: 'Foldable', cats: ['Baby Care'], subs: ['Baby gear'], kind: 'toggle', values: YES_NO },
  { code: 'max_weight', name: 'Max weight', cats: ['Baby Care'], subs: ['Baby gear'], kind: 'chips', unit: 'kg', values: ['Up to 15 kg', '15 – 22 kg', '22 kg or more'] },

  // ── 4 Bags, Luggage & Travel ──
  { code: 'ptype_bags', name: 'Product type', cats: ['Bags, Luggage & Travel'], kind: 'chips', values: ['Backpack', 'Cabin trolley', 'Check-in trolley', 'Luggage set', 'Laptop bag', 'Laptop sleeve', 'Duffel bag', 'Gym bag', 'School bag', 'Travel pouch', 'Neck pillow', 'Luggage tag', 'Waist bag'] },
  { code: 'bag_capacity', name: 'Capacity', cats: ['Bags, Luggage & Travel'], kind: 'chips', unit: 'L', values: ['Under 20 L', '20 – 30 L', '30 – 40 L', '40 – 60 L', '60 L or more'] },
  { code: 'bag_material', name: 'Material', cats: ['Bags, Luggage & Travel', WATCHES], kind: 'chips', values: ['Polyester', 'Nylon', 'Canvas', 'Leather', 'Faux leather', 'Polycarbonate', 'ABS', 'Polypropylene', 'Jute'] },
  { code: 'compartments', name: 'Compartments', cats: ['Bags, Luggage & Travel'], kind: 'chips', values: ['1', '2', '3', '4 or more'] },
  { code: 'laptop_fit', name: 'Fits laptop up to', cats: ['Bags, Luggage & Travel'], subs: ['Backpacks', 'Laptop bags'], kind: 'chips', unit: 'inch', values: ['13"', '14"', '15.6"', '17"'] },
  { code: 'wheels', name: 'Wheels', cats: ['Bags, Luggage & Travel'], subs: ['Suitcases & trolleys'], kind: 'chips', values: ['No wheels', '2 wheels', '4 wheels', '8 wheels'] },
  { code: 'shell', name: 'Shell', cats: ['Bags, Luggage & Travel'], subs: ['Suitcases & trolleys'], kind: 'chips', values: ['Hard shell', 'Soft shell'] },
  { code: 'tsa_lock', name: 'TSA lock', cats: ['Bags, Luggage & Travel'], subs: ['Suitcases & trolleys'], kind: 'toggle', values: YES_NO },
  { code: 'water_resistant', name: 'Water resistant', cats: ['Bags, Luggage & Travel', 'Footwear', 'Electronics'], kind: 'toggle', values: YES_NO },
  { code: 'gender', name: 'Gender', cats: ['Bags, Luggage & Travel', 'Footwear', WATCHES, 'Toys & Games'], kind: 'chips', values: ['Men', 'Women', 'Boys', 'Girls', 'Unisex'] },

  // ── 5 Beauty & Grooming ──
  { code: 'beauty_type', name: 'Product type', cats: [BEAUTY], kind: 'chips', values: ['Face wash', 'Moisturiser', 'Sunscreen', 'Serum', 'Face mask', 'Toner', 'Scrub', 'Lipstick', 'Mascara', 'Eyeshadow', 'Eyeliner & kajal', 'Foundation', 'Compact & face powder', 'Blush & highlighter', 'Nail polish', 'Nail polish remover', 'Perfume', 'Deodorant', 'Shampoo', 'Conditioner', 'Hair oil', 'Hair colour', 'Body lotion', 'Body wash', 'Soap', 'Hand wash', 'Toothpaste', 'Toothbrush', 'Mouthwash', 'Sanitary pads', 'Intimate wash', 'Shaving & beard care', 'Trimmer', 'Hair dryer', 'Hair straightener', 'Makeup brush'] },
  { code: 'for', name: 'For', cats: [BEAUTY], kind: 'chips', values: ['Men', 'Women', 'Unisex', 'Kids'] },
  { code: 'skin_type', name: 'Skin type', cats: [BEAUTY], subs: ['Skin care', 'Makeup', 'Bath & body', "Men's grooming"], kind: 'chips', values: ['Normal', 'Dry', 'Oily', 'Combination', 'Sensitive', 'All skin types'] },
  { code: 'concern', name: 'Concern', cats: [BEAUTY], subs: ['Skin care', 'Hair care', 'Oral care'], kind: 'chips', values: ['Acne', 'Dark spots', 'Ageing', 'Dullness', 'Dryness', 'Pigmentation', 'Hydration', 'Tan', 'Hair fall', 'Dandruff', 'Cavity', 'Sensitivity', 'Whitening'] },
  { code: 'formulation', name: 'Formulation', cats: [BEAUTY], kind: 'chips', values: ['Cream', 'Gel', 'Liquid', 'Powder', 'Oil', 'Foam', 'Spray', 'Stick', 'Bar', 'Sheet', 'Paste'] },
  { code: 'finish', name: 'Finish', cats: [BEAUTY], subs: ['Makeup', 'Nail care'], kind: 'chips', values: ['Matte', 'Glossy', 'Satin', 'Shimmer', 'Natural', 'Dewy'] },
  { code: 'shade', name: 'Shade', cats: [BEAUTY], subs: ['Makeup', 'Nail care'], kind: 'swatch', variant: true, values: [['Red', '#C62828'], ['Pink', '#EC407A'], ['Nude', '#D4A28C'], ['Brown', '#6D4C41'], ['Coral', '#FF7F50'], ['Berry', '#8E244D'], ['Black', '#111111'], ['Clear', null]] },
  { code: 'spf', name: 'SPF', cats: [BEAUTY], subs: ['Skin care', "Men's grooming"], kind: 'chips', values: ['SPF 15–29', 'SPF 30–49', 'SPF 50+'] },
  { code: 'fragrance_family', name: 'Fragrance family', cats: [BEAUTY], subs: ['Fragrances'], kind: 'chips', values: ['Floral', 'Woody', 'Fresh', 'Citrus', 'Oriental', 'Fruity', 'Aquatic', 'Musky'] },
  { code: 'fragrance_strength', name: 'Concentration', cats: [BEAUTY], subs: ['Fragrances'], kind: 'chips', values: ['Eau de Parfum', 'Eau de Toilette', 'Eau de Cologne', 'Body mist', 'Attar'] },
  { code: 'hair_type', name: 'Hair type', cats: [BEAUTY], subs: ['Hair care'], kind: 'chips', values: ['Normal', 'Dry', 'Oily', 'Curly', 'Straight', 'Frizzy', 'Coloured'] },
  { code: 'volume', name: 'Volume', cats: [BEAUTY, 'Household Supplies'], kind: 'chips', unit: 'ml', variant: true, values: ['30 ml', '50 ml', '100 ml', '150 ml', '200 ml', '250 ml', '400 ml', '500 ml', '1 L', '2 L', '5 L'] },
  { code: 'claims', name: 'Free from', cats: [BEAUTY], kind: 'chips', values: ['Paraben-free', 'Sulphate-free', 'Cruelty-free', 'Vegan', 'Natural / Ayurvedic', 'Dermatologically tested', 'Fragrance-free', 'Alcohol-free'] },
  { code: 'corded', name: 'Power', cats: [BEAUTY], subs: ['Grooming appliances'], kind: 'chips', values: ['Cordless', 'Corded', 'Corded & cordless'] },
  { code: 'run_time', name: 'Run time', cats: [BEAUTY], subs: ['Grooming appliances'], kind: 'chips', values: ['Under 45 min', '45 – 90 min', '90 min or more'] },

  // ── 6 Books ──
  { code: 'book_language', name: 'Language', cats: ['Books'], kind: 'chips', values: ['English', 'Tamil', 'Hindi', 'Malayalam', 'Telugu', 'Kannada', 'Other'] },
  { code: 'book_format', name: 'Format', cats: ['Books'], kind: 'chips', values: ['Paperback', 'Hardcover', 'Board book'] },
  { code: 'book_genre', name: 'Genre', cats: ['Books'], kind: 'chips', values: ['Literature & fiction', 'Thriller & mystery', 'Romance', 'Biography', 'Self-help', 'Business', 'History', 'Science', 'Cooking', 'Health', 'Spirituality', 'Picture books', 'Comics & manga'] },
  { code: 'exam', name: 'Exam', cats: ['Books'], subs: ['Competitive exams'], kind: 'chips', values: ['NEET', 'JEE', 'UPSC', 'TNPSC', 'SSC', 'Banking', 'Railways', 'GATE', 'CAT'] },
  { code: 'class', name: 'Class', cats: ['Books', 'Stationery & Office'], kind: 'chips', values: ['Pre-school', 'Class 1–5', 'Class 6–8', 'Class 9–10', 'Class 11–12', 'College'] },
  { code: 'book_age', name: 'Reading age', cats: ['Books'], subs: ["Children's books", 'Comics'], kind: 'chips', values: ['0–3 years', '3–5 years', '6–8 years', '9–12 years', 'Teen'] },
  { code: 'book_condition', name: 'Condition', cats: ['Books'], kind: 'chips', values: ['New', 'Used'] },

  // ── 7 Computers & 21 Mobiles ──
  { code: 'ptype_computers', name: 'Product type', cats: [COMPUTERS], kind: 'chips', values: ['Laptop', 'Tablet', 'Desktop', 'All-in-one', 'Monitor', 'Inkjet printer', 'Laser printer', 'Ink & toner', 'Keyboard', 'Mouse', 'Combo keyboard & mouse', 'Pen drive', 'Hard disk', 'SSD', 'Memory card reader', 'Router', 'Wi-Fi adapter', 'RAM', 'Graphics card', 'Webcam', 'UPS', 'Software'] },
  { code: 'ptype_mobiles', name: 'Product type', cats: [MOBILES], kind: 'chips', values: ['Smartphone', 'Feature phone', 'Case & cover', 'Screen guard', 'Charger', 'Wireless charger', 'Cable', 'Power bank', 'Memory card', 'Holder & stand', 'Selfie stick', 'Ring light'] },
  { code: 'ram', name: 'RAM', cats: [MOBILES, COMPUTERS], subs: ['Smartphones', 'Laptops', 'Tablets', 'Desktops'], kind: 'chips', unit: 'GB', variant: true, values: ['2 GB', '3 GB', '4 GB', '6 GB', '8 GB', '12 GB', '16 GB', '32 GB'] },
  { code: 'storage', name: 'Storage', cats: [MOBILES, COMPUTERS], subs: ['Smartphones', 'Laptops', 'Tablets', 'Desktops', 'Storage devices', 'Memory cards'], kind: 'chips', unit: 'GB', variant: true, values: ['16 GB', '32 GB', '64 GB', '128 GB', '256 GB', '512 GB', '1 TB', '2 TB', '4 TB'] },
  { code: 'storage_type', name: 'Storage type', cats: [COMPUTERS], subs: ['Laptops', 'Desktops', 'Storage devices'], kind: 'chips', values: ['SSD', 'HDD', 'SSD + HDD', 'eMMC'] },
  { code: 'screen', name: 'Screen size', cats: [MOBILES, COMPUTERS], subs: ['Smartphones', 'Laptops', 'Tablets', 'Monitors'], kind: 'range', unit: 'inch', values: ['5.5', '6.1', '6.5', '6.7', '8', '10.1', '11', '12.9', '13', '14', '15.6', '16', '17', '22', '24', '27', '32'] },
  { code: 'battery', name: 'Battery', cats: [MOBILES, COMPUTERS], subs: ['Smartphones', 'Tablets', 'Feature phones'], kind: 'chips', unit: 'mAh', values: ['Under 4,000 mAh', '4,000 – 5,000 mAh', '5,000 mAh or more'] },
  { code: 'processor', name: 'Processor', cats: [COMPUTERS], subs: ['Laptops', 'Tablets', 'Desktops'], kind: 'chips', values: ['Intel Core i3', 'Intel Core i5', 'Intel Core i7', 'Intel Core i9', 'Intel Core Ultra', 'Intel Celeron / Pentium', 'AMD Ryzen 3', 'AMD Ryzen 5', 'AMD Ryzen 7', 'AMD Ryzen 9', 'Apple M1', 'Apple M2', 'Apple M3', 'Apple M4', 'MediaTek', 'Snapdragon'] },
  { code: 'phone_chip', name: 'Processor brand', cats: [MOBILES], subs: ['Smartphones'], kind: 'chips', values: ['Snapdragon', 'MediaTek Dimensity', 'MediaTek Helio', 'Apple Bionic', 'Exynos', 'Google Tensor', 'Unisoc'] },
  { code: 'rear_camera', name: 'Rear camera', cats: [MOBILES], subs: ['Smartphones'], kind: 'chips', values: ['Under 12 MP', '12 – 48 MP', '48 – 64 MP', '64 – 108 MP', '108 MP or more'] },
  { code: 'front_camera', name: 'Front camera', cats: [MOBILES], subs: ['Smartphones'], kind: 'chips', values: ['Under 8 MP', '8 – 16 MP', '16 – 32 MP', '32 MP or more'] },
  { code: 'refresh_rate', name: 'Refresh rate', cats: [MOBILES, COMPUTERS, 'Gaming'], subs: ['Smartphones', 'Laptops', 'Monitors', 'Gaming accessories'], kind: 'chips', unit: 'Hz', values: ['60 Hz', '90 Hz', '120 Hz', '144 Hz', '165 Hz or more'] },
  { code: 'os', name: 'Operating system', cats: [MOBILES, COMPUTERS], kind: 'chips', values: ['Android', 'iOS', 'iPadOS', 'Windows', 'macOS', 'ChromeOS', 'Linux', 'DOS / none'] },
  { code: 'connectivity', name: 'Connectivity', cats: [MOBILES, COMPUTERS, 'Electronics', 'Gaming'], kind: 'chips', values: ['5G', '4G', 'Wi-Fi', 'Bluetooth', 'Wired', 'NFC', 'USB'] },
  { code: 'features', name: 'Features', cats: [MOBILES, COMPUTERS, 'Electronics'], kind: 'chips', values: ['Fast charging', 'Wireless charging', 'Water resistant', 'Dual SIM', 'Fingerprint', 'Face unlock', 'Noise cancelling', 'Touchscreen', 'Backlit keyboard', 'Mic', 'Calling', 'GPS'] },
  { code: 'condition', name: 'Condition', cats: [MOBILES, COMPUTERS, 'Electronics', 'Gaming'], kind: 'chips', values: ['New', 'Refurbished', 'Open box'] },
  { code: 'graphics', name: 'Graphics', cats: [COMPUTERS], subs: ['Laptops', 'Desktops'], kind: 'chips', values: ['Integrated', 'Dedicated (NVIDIA)', 'Dedicated (AMD)'] },
  { code: 'laptop_use', name: 'Use', cats: [COMPUTERS], subs: ['Laptops', 'Desktops'], kind: 'chips', values: ['Student', 'Home & office', 'Business', 'Gaming', 'Creator'] },
  { code: 'laptop_weight', name: 'Weight', cats: [COMPUTERS], subs: ['Laptops'], kind: 'chips', values: ['Under 1.2 kg', '1.2 – 1.5 kg', '1.5 – 2 kg', '2 kg or more'] },
  { code: 'resolution', name: 'Resolution', cats: [COMPUTERS], subs: ['Monitors', 'Laptops'], kind: 'chips', values: ['HD', 'Full HD', 'QHD / 2K', '4K'] },
  { code: 'panel', name: 'Panel type', cats: [COMPUTERS], subs: ['Monitors'], kind: 'chips', values: ['IPS', 'VA', 'TN', 'OLED'] },
  { code: 'printer_type', name: 'Printer type', cats: [COMPUTERS], subs: ['Printers & ink'], kind: 'chips', values: ['Inkjet', 'Ink tank', 'Laser', 'Dot matrix'] },
  { code: 'printer_function', name: 'Functions', cats: [COMPUTERS], subs: ['Printers & ink'], kind: 'chips', values: ['Print only', 'Print, scan & copy', 'Print, scan, copy & fax'] },
  { code: 'print_colour', name: 'Print colour', cats: [COMPUTERS], subs: ['Printers & ink'], kind: 'chips', values: ['Colour', 'Black & white'] },
  { code: 'interface', name: 'Interface', cats: [COMPUTERS, MOBILES], subs: ['Storage devices', 'Chargers & cables', 'Memory cards', 'Keyboards & mice'], kind: 'chips', values: ['USB 2.0', 'USB 3.0', 'USB Type-C', 'Lightning', 'Micro USB', 'Bluetooth', 'Wireless 2.4 GHz'] },
  { code: 'router_speed', name: 'Wi-Fi speed', cats: [COMPUTERS], subs: ['Networking'], kind: 'chips', values: ['Up to 300 Mbps', '300 – 1,200 Mbps', '1,200 Mbps or more'] },
  { code: 'router_band', name: 'Band', cats: [COMPUTERS], subs: ['Networking'], kind: 'chips', values: ['Single band', 'Dual band', 'Tri band', 'Mesh'] },
  { code: 'fits_phone', name: 'Fits phone', cats: [MOBILES], subs: ['Cases & covers', 'Screen guards'], kind: 'chips', values: ['iPhone', 'Samsung', 'OnePlus', 'Vivo', 'Oppo', 'Realme', 'Redmi / Xiaomi', 'Motorola', 'Google Pixel', 'Universal'] },
  { code: 'charger_watts', name: 'Charger power', cats: [MOBILES], subs: ['Chargers & cables'], kind: 'chips', unit: 'W', values: ['Up to 15 W', '18 – 25 W', '30 – 45 W', '65 W or more'] },
  { code: 'powerbank_mah', name: 'Capacity', cats: [MOBILES], subs: ['Power banks'], kind: 'chips', unit: 'mAh', values: ['Up to 10,000 mAh', '10,000 – 20,000 mAh', '20,000 mAh or more'] },

  // ── 8 Electronics ──
  { code: 'ptype_electronics', name: 'Product type', cats: ['Electronics'], kind: 'chips', values: ['True wireless earbuds', 'Neckband', 'Wired earphones', 'Over-ear headphones', 'On-ear headphones', 'Bluetooth speaker', 'Smart speaker', 'Party speaker', 'Soundbar', 'Home theatre', 'DSLR', 'Mirrorless camera', 'Action camera', 'Camera accessory', 'Smartwatch', 'Fitness band', 'Smart bulb', 'Smart plug', 'CCTV camera', 'Video doorbell', 'Projector', 'Batteries'] },
  { code: 'headphone_type', name: 'Headphone type', cats: ['Electronics'], subs: ['Headphones & earphones'], kind: 'chips', values: ['In-ear (TWS)', 'Neckband', 'Wired in-ear', 'On-ear', 'Over-ear'] },
  { code: 'play_time', name: 'Battery life', cats: ['Electronics'], subs: ['Headphones & earphones', 'Speakers', 'Smartwatches & fitness bands'], kind: 'chips', values: ['Under 10 hours', '10 – 30 hours', '30 – 50 hours', '50 hours or more'] },
  { code: 'speaker_output', name: 'Output', cats: ['Electronics'], subs: ['Speakers', 'Home theatre & soundbars'], kind: 'chips', unit: 'W', values: ['Under 10 W', '10 – 30 W', '30 – 100 W', '100 – 300 W', '300 W or more'] },
  { code: 'portable', name: 'Portable', cats: ['Electronics'], subs: ['Speakers', 'Projectors'], kind: 'toggle', values: YES_NO },
  { code: 'camera_type', name: 'Camera type', cats: ['Electronics'], subs: ['Cameras & accessories'], kind: 'chips', values: ['DSLR', 'Mirrorless', 'Point & shoot', 'Action camera', 'Instant camera'] },
  { code: 'megapixels', name: 'Megapixels', cats: ['Electronics'], subs: ['Cameras & accessories'], kind: 'chips', values: ['Under 20 MP', '20 – 30 MP', '30 MP or more'] },
  { code: 'watch_compat', name: 'Works with', cats: ['Electronics'], subs: ['Smartwatches & fitness bands'], kind: 'chips', values: ['Android', 'iOS', 'Android & iOS'] },
  { code: 'watch_display', name: 'Display', cats: ['Electronics'], subs: ['Smartwatches & fitness bands'], kind: 'chips', values: ['AMOLED', 'LCD', 'TFT', 'Always-on'] },
  { code: 'cctv_resolution', name: 'Video resolution', cats: ['Electronics'], subs: ['Smart home'], kind: 'chips', values: ['720p', '1080p', '2K', '4K'] },
  { code: 'indoor_outdoor', name: 'Use', cats: ['Electronics', 'Garden & Outdoors'], subs: ['Smart home', 'Plants & seeds'], kind: 'chips', values: ['Indoor', 'Outdoor', 'Indoor & outdoor'] },
  { code: 'night_vision', name: 'Night vision', cats: ['Electronics'], subs: ['Smart home'], kind: 'toggle', values: YES_NO },

  // ── 9–11 Fashion (Men's / Women's / Kids') ──
  { code: 'ptype_men', name: 'Product type', cats: [MEN], kind: 'chips', values: ['T-shirt', 'Polo', 'Shirt', 'Jeans', 'Trousers', 'Chinos', 'Shorts', 'Track pants', 'Joggers', 'Kurta', 'Kurta set', 'Veshti / dhoti', 'Lungi', 'Vest', 'Briefs', 'Trunks & boxers', 'Pyjama', 'Hoodie', 'Sweatshirt', 'Sweater', 'Jacket', 'Blazer', 'Suit', 'Raincoat'] },
  { code: 'ptype_women', name: 'Product type', cats: [WOMEN], kind: 'chips', values: ['Saree', 'Kurta', 'Kurti', 'Kurta set', 'Salwar suit', 'Dress material', 'Lehenga', 'Top', 'T-shirt', 'Shirt', 'Dress', 'Gown', 'Skirt', 'Jeans', 'Trousers', 'Palazzo', 'Leggings', 'Bra', 'Panty', 'Shapewear', 'Nightdress', 'Night suit', 'Sweater', 'Jacket', 'Sports bra', 'Track pants'] },
  { code: 'ptype_kids', name: 'Product type', cats: [KIDS], kind: 'chips', values: ['T-shirt', 'Shirt', 'Frock', 'Dress', 'Top', 'Jeans', 'Shorts', 'Track pants', 'Clothing set', 'Romper', 'Onesie', 'Kurta set', 'Pattu pavadai', 'Lehenga', 'School uniform', 'Nightwear', 'Innerwear', 'Sweater', 'Jacket'] },
  { code: 'department', name: 'Gender', cats: [KIDS], kind: 'chips', values: ['Boys', 'Girls', 'Unisex'] },
  { code: 'kids_age', name: 'Age', cats: [KIDS], kind: 'chips', variant: true, values: AGE_KIDS },
  { code: 'size', name: 'Size', cats: APPAREL, kind: 'chips', variant: true, values: ['XS', 'S', 'M', 'L', 'XL', 'XXL', '3XL', '4XL', 'Free size'] },
  { code: 'waist', name: 'Waist', cats: [MEN, WOMEN], subs: ['Jeans', 'Trousers', 'Shorts & track pants', 'Jeans & trousers'], kind: 'chips', unit: 'in', variant: true, values: ['26', '28', '30', '32', '34', '36', '38', '40', '42'] },
  { code: 'bra_size', name: 'Bra size', cats: [WOMEN], subs: ['Innerwear & lingerie'], kind: 'chips', variant: true, values: ['30B', '32B', '32C', '34B', '34C', '34D', '36B', '36C', '36D', '38B', '38C', '40C'] },
  { code: 'bra_padding', name: 'Padding', cats: [WOMEN], subs: ['Innerwear & lingerie'], kind: 'chips', values: ['Padded', 'Non-padded', 'Lightly padded'] },
  { code: 'bra_wiring', name: 'Wiring', cats: [WOMEN], subs: ['Innerwear & lingerie'], kind: 'chips', values: ['Wired', 'Non-wired'] },
  { code: 'fabric', name: 'Fabric', cats: APPAREL, kind: 'chips', values: ['Cotton', 'Organic cotton', 'Linen', 'Denim', 'Polyester', 'Cotton blend', 'Rayon / Viscose', 'Wool', 'Fleece', 'Silk', 'Georgette', 'Chiffon', 'Crepe', 'Satin', 'Net', 'Lycra / Spandex', 'Khadi', 'Leather', 'Synthetic'] },
  { code: 'fit', name: 'Fit', cats: APPAREL, kind: 'chips', values: ['Slim', 'Regular', 'Relaxed', 'Oversized', 'Loose', 'Straight', 'Skinny', 'Tapered', 'Bootcut', 'Wide leg'] },
  { code: 'pattern', name: 'Pattern', cats: APPAREL, kind: 'chips', values: ['Solid', 'Striped', 'Checked', 'Printed', 'Graphic', 'Floral', 'Textured', 'Embroidered', 'Self design', 'Colourblocked'] },
  { code: 'sleeve', name: 'Sleeve', cats: APPAREL, kind: 'chips', values: ['Sleeveless', 'Short sleeve', 'Half sleeve', 'Three-quarter sleeve', 'Full sleeve'] },
  { code: 'neck', name: 'Neck / collar', cats: APPAREL, kind: 'chips', values: ['Crew neck', 'Round neck', 'V-neck', 'Polo collar', 'Spread collar', 'Mandarin collar', 'Hooded', 'Boat neck', 'Square neck', 'Sweetheart neck'] },
  { code: 'rise', name: 'Rise', cats: [MEN, WOMEN], subs: ['Jeans', 'Trousers', 'Jeans & trousers', 'Leggings'], kind: 'chips', values: ['Low rise', 'Mid rise', 'High rise'] },
  { code: 'length', name: 'Length', cats: [WOMEN, KIDS], kind: 'chips', values: ['Cropped', 'Regular length', 'Mini', 'Knee length', 'Midi', 'Maxi', 'Ankle length', 'Calf length'] },
  { code: 'occasion', name: 'Occasion', cats: [...APPAREL, 'Footwear', WATCHES], kind: 'chips', values: ['Casual', 'Formal', 'Party', 'Festive', 'Wedding', 'Workwear', 'Sports', 'Ethnic', 'Daily wear'] },
  { code: 'closure', name: 'Closure', cats: [MEN, WOMEN, KIDS, 'Footwear'], kind: 'chips', values: ['Button', 'Zip', 'Elastic', 'Drawstring', 'Hook', 'Lace-up', 'Velcro', 'Slip-on', 'Buckle'] },
  { code: 'pack_of', name: 'Pack of', cats: APPAREL, kind: 'chips', values: ['1', '2', '3', '4', '5 or more'] },
  { code: 'style', name: 'Style', cats: [MEN, WOMEN], kind: 'chips', values: ['Basic', 'Premium', 'Streetwear', 'Minimal', 'Trendy', 'Classic'] },
  { code: 'season', name: 'Season', cats: APPAREL, kind: 'chips', values: ['Summer', 'Winter', 'Monsoon', 'All season'] },
  { code: 'sustainability', name: 'Sustainability', cats: APPAREL, kind: 'chips', values: ['Organic', 'Recycled', 'Handloom', 'Vegan leather'] },
  { code: 'ethnic_work', name: 'Work', cats: [MEN, WOMEN, KIDS], subs: ['Ethnic wear', 'Sarees', 'Kurtas & kurtis', 'Salwar suits & dress material', 'Lehengas', 'Kids ethnic wear'], kind: 'chips', values: ['Embroidered', 'Printed', 'Zari', 'Sequinned', 'Mirror work', 'Woven', 'Plain'] },
  { code: 'saree_type', name: 'Saree type', cats: [WOMEN], subs: ['Sarees'], kind: 'chips', values: ['Kanjivaram', 'Banarasi', 'Chettinad', 'Chanderi', 'Kota', 'Mysore silk', 'Pochampally', 'Bandhani', 'Paithani', 'Daily wear'] },
  { code: 'saree_fabric', name: 'Saree fabric', cats: [WOMEN], subs: ['Sarees'], kind: 'chips', values: ['Silk', 'Art silk', 'Cotton', 'Cotton silk', 'Georgette', 'Chiffon', 'Crepe', 'Organza', 'Linen', 'Net'] },
  { code: 'blouse_piece', name: 'Blouse piece', cats: [WOMEN], subs: ['Sarees'], kind: 'toggle', values: ['Included', 'Not included'] },
  { code: 'saree_border', name: 'Border', cats: [WOMEN], subs: ['Sarees'], kind: 'chips', values: ['Zari border', 'Contrast border', 'Temple border', 'No border'] },
  { code: 'kurta_set', name: 'Set', cats: [WOMEN, MEN], subs: ['Kurtas & kurtis', 'Ethnic wear', 'Salwar suits & dress material'], kind: 'chips', values: ['Kurta only', 'Kurta with pant', 'Kurta with dupatta', 'Kurta, pant & dupatta'] },

  // ── 12 Footwear ──
  { code: 'ptype_footwear', name: 'Product type', cats: ['Footwear'], kind: 'chips', values: ['Sports shoes', 'Running shoes', 'Sneakers', 'Casual shoes', 'Formal shoes', 'Loafers', 'Boots', 'Sandals', 'Floaters', 'Slippers & flip-flops', 'Flats', 'Heels', 'Wedges', 'Juttis & mojaris', 'School shoes', 'Socks', 'Shoe care'] },
  { code: 'shoe_size', name: 'Shoe size', cats: ['Footwear'], kind: 'chips', unit: 'UK', variant: true, values: ['UK 1', 'UK 2', 'UK 3', 'UK 4', 'UK 5', 'UK 6', 'UK 7', 'UK 8', 'UK 9', 'UK 10', 'UK 11', 'UK 12'] },
  { code: 'upper_material', name: 'Upper material', cats: ['Footwear'], kind: 'chips', values: ['Leather', 'Synthetic leather', 'Mesh', 'Canvas', 'Knit', 'Suede', 'Rubber', 'PU'] },
  { code: 'sole_material', name: 'Sole', cats: ['Footwear'], kind: 'chips', values: ['Rubber', 'EVA', 'PU', 'TPR', 'Phylon'] },
  { code: 'heel_height', name: 'Heel height', cats: ['Footwear'], subs: ["Women's footwear"], kind: 'chips', values: ['Flat', 'Low (up to 2")', 'Mid (2–3")', 'High (3" or more)'] },

  // ── 13 Gaming ──
  { code: 'platform', name: 'Platform', cats: ['Gaming'], kind: 'chips', values: ['PlayStation 5', 'PlayStation 4', 'Xbox Series X|S', 'Nintendo Switch', 'PC', 'Mobile'] },
  { code: 'game_genre', name: 'Genre', cats: ['Gaming'], subs: ['Video games'], kind: 'chips', values: ['Action', 'Adventure', 'Racing', 'Sports', 'Shooter', 'RPG', 'Strategy', 'Kids & family'] },
  { code: 'age_rating', name: 'Age rating', cats: ['Gaming'], subs: ['Video games'], kind: 'chips', values: ['3+', '7+', '12+', '16+', '18+'] },
  { code: 'ptype_gaming', name: 'Product type', cats: ['Gaming'], kind: 'chips', values: ['Console', 'Game', 'Controller', 'Gaming headset', 'Gaming mouse', 'Gaming keyboard', 'Gaming chair', 'Gift card'] },

  // ── 14 Garden & Outdoors ──
  { code: 'plant_type', name: 'Plant type', cats: ['Garden & Outdoors'], subs: ['Plants & seeds'], kind: 'chips', values: ['Indoor plant', 'Outdoor plant', 'Flowering', 'Succulent & cactus', 'Herb', 'Vegetable seeds', 'Flower seeds', 'Fruit plant'] },
  { code: 'sunlight', name: 'Sunlight', cats: ['Garden & Outdoors'], subs: ['Plants & seeds'], kind: 'chips', values: ['Full sun', 'Partial sun', 'Shade'] },
  { code: 'pot_material', name: 'Pot material', cats: ['Garden & Outdoors'], subs: ['Pots & planters'], kind: 'chips', values: ['Plastic', 'Ceramic', 'Clay / terracotta', 'Metal', 'Fibre', 'Cement'] },
  { code: 'pot_size', name: 'Pot size', cats: ['Garden & Outdoors'], subs: ['Pots & planters'], kind: 'chips', values: ['Small (up to 6")', 'Medium (6–10")', 'Large (10–14")', 'Extra large (14" or more)'] },
  { code: 'garden_tool', name: 'Tool type', cats: ['Garden & Outdoors'], subs: ['Gardening tools'], kind: 'chips', values: ['Trowel', 'Pruner', 'Rake', 'Hose', 'Sprayer', 'Watering can', 'Gloves', 'Tool kit'] },

  // ── 15 Grocery ──
  { code: 'veg_mark', name: 'Veg / non-veg', cats: ['Grocery', 'Restaurant & Food', 'Health & Pharmacy', 'Pet Supplies'], kind: 'swatch', values: VEG },
  { code: 'dietary', name: 'Dietary', cats: ['Grocery', 'Restaurant & Food', 'Health & Pharmacy'], kind: 'chips', values: ['Vegetarian', 'Vegan', 'Organic', 'Gluten-free', 'Sugar-free', 'Jain', 'High protein', 'Keto', 'Low fat'] },
  { code: 'form', name: 'Form', cats: ['Grocery'], kind: 'chips', values: ['Fresh', 'Frozen', 'Dried', 'Packaged', 'Ready to cook', 'Ready to eat'] },
  { code: 'weight', name: 'Weight / volume', cats: ['Grocery', 'Pet Supplies', 'Household Supplies'], kind: 'chips', variant: true, values: ['50 g', '100 g', '200 g', '250 g', '500 g', '1 kg', '2 kg', '5 kg', '10 kg', '25 kg', '100 ml', '200 ml', '250 ml', '500 ml', '1 L', '2 L', '5 L', '15 L'] },
  { code: 'shelf_life', name: 'Shelf life', cats: ['Grocery'], kind: 'chips', values: ['Under 1 week', '1 week – 1 month', '1 – 6 months', '6 months or more'] },
  { code: 'rice_variety', name: 'Rice variety', cats: ['Grocery'], subs: ['Atta, rice & dals'], kind: 'chips', values: ['Ponni', 'Basmati', 'Sona Masoori', 'Seeraga samba', 'Idli rice', 'Brown rice', 'Red rice', 'Matta rice'] },
  { code: 'oil_type', name: 'Oil type', cats: ['Grocery'], subs: ['Oils & ghee'], kind: 'chips', values: ['Groundnut', 'Gingelly / sesame', 'Coconut', 'Sunflower', 'Rice bran', 'Mustard', 'Olive', 'Palm', 'Ghee'] },
  { code: 'cold_pressed', name: 'Cold pressed (marachekku)', cats: ['Grocery'], subs: ['Oils & ghee'], kind: 'toggle', values: YES_NO },
  { code: 'meat_type', name: 'Meat type', cats: ['Grocery'], subs: ['Meat, fish & chicken'], kind: 'chips', values: ['Chicken', 'Country chicken', 'Mutton', 'Fish', 'Prawns', 'Crab', 'Eggs'] },
  { code: 'meat_cut', name: 'Cut', cats: ['Grocery'], subs: ['Meat, fish & chicken'], kind: 'chips', values: ['Curry cut', 'Boneless', 'Whole', 'Fillet', 'Mince', 'Drumsticks'] },
  { code: 'coffee_type', name: 'Coffee type', cats: ['Grocery'], subs: ['Tea, coffee & drinks'], kind: 'chips', values: ['Filter coffee', 'Instant coffee', 'Coffee beans', 'Tea leaves', 'Tea bags', 'Green tea'] },
  { code: 'chicory', name: 'Chicory', cats: ['Grocery'], subs: ['Tea, coffee & drinks'], kind: 'chips', values: ['100% coffee', '90:10', '80:20', '70:30'] },
  { code: 'demo_pack', name: 'Pack size', cats: ['Grocery'], kind: 'chips', values: [] },

  // ── 16 Health & Pharmacy ──
  { code: 'ptype_health', name: 'Product type', cats: ['Health & Pharmacy'], kind: 'chips', values: ['Pain relief', 'Cold & cough', 'Digestion', 'Skin ointment', 'Multivitamin', 'Protein supplement', 'Omega 3', 'Calcium', 'BP monitor', 'Glucometer', 'Thermometer', 'Pulse oximeter', 'Nebuliser', 'Bandage', 'Antiseptic', 'Ayurvedic', 'Homeopathic', 'Walking stick', 'Adult diapers', 'Mask', 'Sanitiser'] },
  { code: 'med_form', name: 'Form', cats: ['Health & Pharmacy'], kind: 'chips', values: ['Tablet', 'Capsule', 'Syrup', 'Powder', 'Gummies', 'Drops', 'Cream / ointment', 'Spray', 'Device'] },
  { code: 'rx_required', name: 'Prescription', cats: ['Health & Pharmacy'], kind: 'chips', values: ['No prescription needed (OTC)', 'Prescription needed (Rx)'] },
  { code: 'health_concern', name: 'Health concern', cats: ['Health & Pharmacy'], kind: 'chips', values: ['Diabetes', 'Blood pressure', 'Heart', 'Joint & bone', 'Immunity', 'Digestion', 'Weight', 'Skin & hair', 'Women\'s health', 'Sleep & stress', 'Pain'] },
  { code: 'health_age', name: 'For', cats: ['Health & Pharmacy'], kind: 'chips', values: ['Adults', 'Kids', 'Seniors', 'Women', 'Men'] },
  { code: 'medicine_system', name: 'System', cats: ['Health & Pharmacy'], kind: 'chips', values: ['Allopathy', 'Ayurveda', 'Homeopathy', 'Siddha', 'Unani'] },

  // ── 17 Home & Furniture ──
  { code: 'home_type', name: 'Product type', cats: [HOME], kind: 'chips', values: ['Sofa', 'Sofa bed', 'Bed', 'Dining table', 'Coffee table', 'Side table', 'Study table', 'Chair', 'Office chair', 'Wardrobe', 'Shoe rack', 'Bookshelf', 'TV unit', 'Mattress', 'Pillow', 'Bedsheet', 'Blanket & quilt', 'Curtains', 'Cushion & cover', 'Carpet & rug', 'Wall decor', 'Wall clock', 'Photo frame', 'Showpiece', 'Artificial plant', 'Table lamp', 'Ceiling light', 'Storage box', 'Towel', 'Bath fitting'] },
  { code: 'room', name: 'Room', cats: [HOME, KITCHEN], kind: 'chips', values: ['Living room', 'Bedroom', 'Kitchen', 'Dining', 'Bathroom', 'Study', 'Outdoor', 'Kids room', 'Pooja room'] },
  { code: 'home_material', name: 'Material', cats: [HOME, KITCHEN], kind: 'chips', values: ['Wood', 'Sheesham wood', 'Engineered wood', 'Metal', 'Stainless steel', 'Aluminium', 'Brass', 'Copper', 'Glass', 'Ceramic', 'Porcelain', 'Melamine', 'Plastic', 'Fabric', 'Cotton', 'Bamboo', 'Marble', 'Silicone', 'Non-stick', 'Cast iron', 'Hard anodised'] },
  { code: 'home_finish', name: 'Finish', cats: [HOME], subs: ['Furniture'], kind: 'chips', values: ['Natural wood', 'Walnut', 'Teak', 'Wenge', 'White', 'Black', 'Grey'] },
  { code: 'assembly', name: 'Assembly', cats: [HOME, 'Garden & Outdoors'], subs: ['Furniture', 'Outdoor furniture'], kind: 'chips', values: ['Pre-assembled', 'DIY assembly', 'Carpenter assembly'] },
  { code: 'seating', name: 'Seats', cats: [HOME], subs: ['Furniture'], kind: 'chips', values: ['1 seater', '2 seater', '3 seater', '4 seater', '6 seater or more'] },
  { code: 'storage_included', name: 'Storage included', cats: [HOME], subs: ['Furniture'], kind: 'toggle', values: YES_NO },
  { code: 'bed_size', name: 'Bed size', cats: [HOME], subs: ['Furniture', 'Furnishing', 'Mattresses & pillows'], kind: 'chips', variant: true, values: ['Single', 'Double', 'Queen', 'King'] },
  { code: 'mattress_thickness', name: 'Thickness', cats: [HOME], subs: ['Mattresses & pillows'], kind: 'chips', values: ['4 inch', '5 inch', '6 inch', '8 inch', '10 inch or more'] },
  { code: 'mattress_type', name: 'Mattress type', cats: [HOME], subs: ['Mattresses & pillows'], kind: 'chips', values: ['Memory foam', 'Foam', 'Spring', 'Pocket spring', 'Coir', 'Latex', 'Hybrid'] },
  { code: 'firmness', name: 'Firmness', cats: [HOME], subs: ['Mattresses & pillows'], kind: 'chips', values: ['Soft', 'Medium', 'Firm', 'Dual comfort'] },
  { code: 'thread_count', name: 'Thread count', cats: [HOME], subs: ['Furnishing'], kind: 'chips', values: ['Under 150', '150 – 250', '250 – 400', '400 or more'] },
  { code: 'pillow_covers', name: 'Pillow covers', cats: [HOME], subs: ['Furnishing'], kind: 'chips', values: ['None', '1', '2', '4'] },
  { code: 'curtain_length', name: 'Curtain length', cats: [HOME], subs: ['Furnishing'], kind: 'chips', variant: true, values: ['Window (5 ft)', 'Door (7 ft)', 'Long door (9 ft)'] },
  { code: 'blackout', name: 'Blackout', cats: [HOME], subs: ['Furnishing'], kind: 'toggle', values: YES_NO },
  { code: 'bulb_type', name: 'Bulb type', cats: [HOME, TOOLS], subs: ['Lighting', 'Bulbs & lights'], kind: 'chips', values: ['LED', 'CFL', 'Halogen', 'Filament', 'Tube light', 'Strip light'] },
  { code: 'wattage', name: 'Wattage', cats: [HOME, TOOLS], subs: ['Lighting', 'Bulbs & lights', 'Power tools', 'Electricals'], kind: 'chips', unit: 'W', values: ['Up to 9 W', '10 – 20 W', '20 – 50 W', '50 – 500 W', '500 – 1,000 W', '1,000 W or more'] },
  { code: 'smart', name: 'Smart (app / voice)', cats: [HOME, 'Electronics'], subs: ['Lighting', 'Smart home'], kind: 'toggle', values: YES_NO },

  // ── 18 Home Improvement & Tools ──
  { code: 'ptype_tools', name: 'Product type', cats: [TOOLS], kind: 'chips', values: ['Screwdriver', 'Spanner & wrench', 'Plier', 'Hammer', 'Tool kit', 'Measuring tape', 'Drill machine', 'Angle grinder', 'Jigsaw', 'Heat gun', 'Wire', 'Switch & socket', 'MCB', 'Extension board', 'LED bulb', 'Tube light', 'Tap', 'Shower', 'Pipe & fitting', 'Wall paint', 'Primer', 'Putty', 'Screws & nails', 'Door lock', 'Padlock', 'Safety gloves', 'Safety goggles'] },
  { code: 'tool_power', name: 'Power source', cats: [TOOLS], subs: ['Hand tools', 'Power tools'], kind: 'chips', values: ['Manual', 'Corded electric', 'Cordless (battery)'] },
  { code: 'voltage', name: 'Voltage', cats: [TOOLS], subs: ['Power tools', 'Electricals'], kind: 'chips', values: ['12 V', '18 V', '20 V', '230 V'] },
  { code: 'ampere', name: 'Ampere', cats: [TOOLS], subs: ['Electricals'], kind: 'chips', values: ['6 A', '10 A', '16 A', '20 A', '32 A', '63 A'] },
  { code: 'wire_size', name: 'Wire size', cats: [TOOLS], subs: ['Electricals'], kind: 'chips', values: ['0.75 sq mm', '1 sq mm', '1.5 sq mm', '2.5 sq mm', '4 sq mm', '6 sq mm'] },
  { code: 'paint_finish', name: 'Paint finish', cats: [TOOLS], subs: ['Paints & wall care'], kind: 'chips', values: ['Matte', 'Satin', 'Gloss', 'Emulsion', 'Enamel', 'Texture'] },
  { code: 'paint_surface', name: 'Surface', cats: [TOOLS], subs: ['Paints & wall care'], kind: 'chips', values: ['Interior wall', 'Exterior wall', 'Wood', 'Metal'] },
  { code: 'paint_volume', name: 'Pack', cats: [TOOLS], subs: ['Paints & wall care'], kind: 'chips', variant: true, values: ['200 ml', '500 ml', '1 L', '4 L', '10 L', '20 L'] },
  { code: 'pipe_size', name: 'Pipe size', cats: [TOOLS], subs: ['Plumbing & sanitary'], kind: 'chips', values: ['1/2"', '3/4"', '1"', '1.25"', '1.5"', '2"', '4"'] },
  { code: 'pipe_material', name: 'Pipe material', cats: [TOOLS], subs: ['Plumbing & sanitary'], kind: 'chips', values: ['PVC', 'CPVC', 'uPVC', 'GI', 'HDPE', 'Brass', 'Stainless steel'] },
  { code: 'lock_type', name: 'Lock type', cats: [TOOLS], subs: ['Locks & security'], kind: 'chips', values: ['Padlock', 'Mortise lock', 'Rim lock', 'Cylindrical lock', 'Digital lock', 'Drawer lock'] },

  // ── 19 Household Supplies ──
  { code: 'ptype_household', name: 'Product type', cats: ['Household Supplies'], kind: 'chips', values: ['Detergent powder', 'Liquid detergent', 'Detergent bar', 'Fabric conditioner', 'Dishwash bar', 'Dishwash liquid', 'Scrubber', 'Floor cleaner', 'Glass cleaner', 'Toilet cleaner', 'Air freshener', 'Mosquito repellent', 'Cockroach killer', 'Garbage bags', 'Tissues', 'Napkins', 'Kitchen towel', 'Broom', 'Mop', 'Bucket'] },
  { code: 'cleaner_form', name: 'Form', cats: ['Household Supplies'], kind: 'chips', values: ['Liquid', 'Powder', 'Bar', 'Gel', 'Spray', 'Pods', 'Tablets'] },
  { code: 'scent', name: 'Fragrance', cats: ['Household Supplies', 'Pooja & Festive'], kind: 'chips', values: ['Lemon', 'Lavender', 'Rose', 'Jasmine', 'Sandalwood', 'Floral', 'Fresh', 'Pine', 'Unscented'] },
  { code: 'wash_type', name: 'Wash type', cats: ['Household Supplies'], subs: ['Detergents & laundry'], kind: 'chips', values: ['Front load', 'Top load', 'Hand wash', 'All machines'] },
  { code: 'eco', name: 'Eco-friendly', cats: ['Household Supplies'], kind: 'toggle', values: YES_NO },

  // ── 20 Kitchen & Dining ──
  { code: 'ptype_kitchen', name: 'Product type', cats: [KITCHEN], kind: 'chips', values: ['Kadai', 'Tawa', 'Fry pan', 'Wok', 'Saucepan', 'Cooking pot', 'Idli maker', 'Pressure cooker', 'Gas stove', 'Knife', 'Chopping board', 'Peeler', 'Grater', 'Strainer & sieve', 'Spatula & ladle', 'Whisk', 'Tongs', 'Rolling pin', 'Squeezer', 'Spoon', 'Fork', 'Cutlery set', 'Plate', 'Bowl', 'Dinner set', 'Tray', 'Serving bowl', 'Glass', 'Cup & mug', 'Container', 'Spice box', 'Rack & stand', 'Bottle', 'Flask', 'Lunch box', 'Ice tray'] },
  { code: 'induction', name: 'Induction compatible', cats: [KITCHEN], subs: ['Cookware', 'Pressure cookers'], kind: 'toggle', values: YES_NO },
  { code: 'pieces', name: 'Pieces in set', cats: [KITCHEN], kind: 'chips', values: ['1', '2', '3', '4–6', '7–12', '13 or more'] },
  { code: 'dishwasher_safe', name: 'Dishwasher safe', cats: [KITCHEN], kind: 'toggle', values: YES_NO },
  { code: 'microwave_safe', name: 'Microwave safe', cats: [KITCHEN], kind: 'toggle', values: YES_NO },
  { code: 'cooker_litres', name: 'Cooker size', cats: [KITCHEN], subs: ['Pressure cookers'], kind: 'chips', variant: true, values: ['1.5 L', '2 L', '3 L', '5 L', '6.5 L', '8 L or more'] },
  { code: 'cooker_lid', name: 'Lid', cats: [KITCHEN], subs: ['Pressure cookers'], kind: 'chips', values: ['Inner lid', 'Outer lid'] },
  { code: 'burners', name: 'Burners', cats: [KITCHEN], subs: ['Gas stoves'], kind: 'chips', values: ['1 burner', '2 burners', '3 burners', '4 burners or more'] },
  { code: 'glass_top', name: 'Glass top', cats: [KITCHEN], subs: ['Gas stoves'], kind: 'toggle', values: YES_NO },
  { code: 'auto_ignition', name: 'Auto ignition', cats: [KITCHEN], subs: ['Gas stoves'], kind: 'toggle', values: YES_NO },
  { code: 'insulated', name: 'Insulated (hot & cold)', cats: [KITCHEN], subs: ['Bottles & flasks', 'Lunch boxes'], kind: 'toggle', values: YES_NO },
  { code: 'bpa_free', name: 'BPA-free', cats: [KITCHEN, 'Baby Care'], subs: ['Bottles & flasks', 'Containers & storage', 'Lunch boxes', 'Feeding & nursing'], kind: 'toggle', values: YES_NO },

  // ── 22 Musical Instruments ──
  { code: 'ptype_music', name: 'Product type', cats: ['Musical Instruments'], kind: 'chips', values: ['Acoustic guitar', 'Electric guitar', 'Ukulele', 'Keyboard', 'Digital piano', 'Tabla', 'Mridangam', 'Drum kit', 'Cajon', 'Flute', 'Harmonium', 'Violin', 'Veena', 'Microphone', 'Audio interface', 'Strings', 'Stand', 'Case'] },
  { code: 'acoustic_electric', name: 'Acoustic / electric', cats: ['Musical Instruments'], kind: 'chips', values: ['Acoustic', 'Electric', 'Electro-acoustic', 'Digital'] },
  { code: 'skill_level', name: 'Skill level', cats: ['Musical Instruments', SPORTS], kind: 'chips', values: ['Beginner', 'Intermediate', 'Professional'] },
  { code: 'music_material', name: 'Material', cats: ['Musical Instruments'], kind: 'chips', values: ['Wood', 'Rosewood', 'Mahogany', 'Spruce', 'Bamboo', 'Brass', 'Metal', 'Plastic'] },
  { code: 'accessories_included', name: 'Accessories included', cats: ['Musical Instruments'], kind: 'toggle', values: YES_NO },

  // ── 23 Pet Supplies ──
  { code: 'pet', name: 'Pet', cats: ['Pet Supplies'], kind: 'chips', values: ['Dog', 'Cat', 'Fish', 'Bird', 'Small animal'] },
  { code: 'breed_size', name: 'Breed size', cats: ['Pet Supplies'], kind: 'chips', values: ['Small', 'Medium', 'Large', 'Giant', 'All breeds'] },
  { code: 'life_stage', name: 'Life stage', cats: ['Pet Supplies'], kind: 'chips', values: ['Puppy / kitten', 'Adult', 'Senior', 'All life stages'] },
  { code: 'pet_food_type', name: 'Food type', cats: ['Pet Supplies'], subs: ['Pet food', 'Dog', 'Cat', 'Fish & aquarium', 'Birds'], kind: 'chips', values: ['Dry food', 'Wet food', 'Treats', 'Supplements'] },
  { code: 'ptype_pets', name: 'Product type', cats: ['Pet Supplies'], kind: 'chips', values: ['Food', 'Treats', 'Bowl', 'Bed', 'Collar & leash', 'Toy', 'Shampoo', 'Brush & comb', 'Litter', 'Cage', 'Aquarium', 'Tick & flea care'] },

  // ── 24 Pooja & Festive ──
  { code: 'ptype_pooja', name: 'Product type', cats: ['Pooja & Festive'], kind: 'chips', values: ['Agarbatti', 'Dhoop', 'Camphor', 'Kumkum & turmeric', 'Oil lamp / vilakku', 'Diya', 'Idol', 'God photo frame', 'Pooja thali', 'Bell', 'Kolam / rangoli', 'Decorative lights', 'Toran', 'Gift hamper', 'Rakhi', 'Crackers'] },
  { code: 'pooja_material', name: 'Material', cats: ['Pooja & Festive'], kind: 'chips', values: ['Brass', 'Copper', 'Silver', 'Panchaloha', 'Clay', 'Marble', 'Wood', 'Resin'] },
  { code: 'festival', name: 'Festival', cats: ['Pooja & Festive'], kind: 'chips', values: ['Pongal', 'Deepavali', 'Navaratri', 'Vinayaka Chaturthi', 'Karthigai Deepam', 'Tamil New Year', 'Christmas', 'Ramzan', 'Raksha Bandhan', 'Onam'] },
  { code: 'item_size', name: 'Size', cats: ['Pooja & Festive'], kind: 'chips', values: ['Small', 'Medium', 'Large'] },

  // ── 25 Restaurant & Food ──
  { code: 'cuisine', name: 'Cuisine', cats: ['Restaurant & Food'], kind: 'chips', values: ['South Indian', 'Chettinad', 'North Indian', 'Chinese', 'Biryani', 'Arabian', 'Continental', 'Italian', 'Street food', 'Bakery', 'Desserts', 'Juices'] },
  { code: 'meal_type', name: 'Meal', cats: ['Restaurant & Food'], kind: 'chips', values: ['Breakfast', 'Lunch', 'Dinner', 'Snacks', 'Late night'] },
  { code: 'spice_level', name: 'Spice level', cats: ['Restaurant & Food'], kind: 'chips', values: ['Mild', 'Medium', 'Spicy', 'Extra spicy'] },
  { code: 'serves', name: 'Serves', cats: ['Restaurant & Food'], kind: 'chips', variant: true, values: ['1', '2', '3–4', 'Family (5+)'] },
  { code: 'pure_veg', name: 'Pure veg restaurant', cats: ['Restaurant & Food'], kind: 'toggle', values: YES_NO },

  // ── 26 Sports & Fitness ──
  { code: 'sport', name: 'Sport', cats: [SPORTS], kind: 'chips', values: ['Cricket', 'Football', 'Badminton', 'Tennis', 'Table tennis', 'Basketball', 'Volleyball', 'Kabaddi', 'Hockey', 'Yoga', 'Gym', 'Running', 'Cycling', 'Swimming', 'Skating', 'Golf', 'Baseball', 'Carrom', 'Chess'] },
  { code: 'sports_type', name: 'Product type', cats: [SPORTS], kind: 'chips', values: ['Bat', 'Ball', 'Racket', 'Shuttlecock', 'Net', 'Stumps', 'Gloves', 'Helmet', 'Pads', 'Dumbbells', 'Kettlebell', 'Weight plates', 'Bench', 'Treadmill', 'Exercise cycle', 'Yoga mat', 'Resistance band', 'Skipping rope', 'Bicycle', 'Swimwear', 'Goggles', 'Tent', 'Sleeping bag', 'Protein', 'Sports bottle', 'Kit bag', 'Board', 'Club'] },
  { code: 'sports_material', name: 'Material', cats: [SPORTS], kind: 'chips', values: ['Rubber', 'Leather', 'Synthetic', 'Steel', 'Cast iron', 'Foam', 'Nylon', 'Polyester', 'Wood', 'Carbon fibre', 'Aluminium', 'PVC'] },
  { code: 'sports_size', name: 'Size', cats: [SPORTS], kind: 'chips', variant: true, values: ['S', 'M', 'L', 'XL', 'XXL', 'Free size', 'Size 3', 'Size 4', 'Size 5', 'Junior', 'Senior'] },
  { code: 'willow', name: 'Willow', cats: [SPORTS], subs: ['Cricket'], kind: 'chips', values: ['English willow', 'Kashmir willow', 'Popular willow', 'Plastic / fibre'] },
  { code: 'bat_weight', name: 'Bat weight', cats: [SPORTS], subs: ['Cricket'], kind: 'chips', values: ['Under 1,100 g', '1,100 – 1,200 g', '1,200 g or more'] },
  { code: 'ball_type', name: 'Ball type', cats: [SPORTS], subs: ['Cricket'], kind: 'chips', values: ['Leather ball', 'Tennis ball', 'Rubber ball', 'Season ball'] },
  { code: 'fitness_weight', name: 'Weight', cats: [SPORTS], subs: ['Gym equipment'], kind: 'chips', variant: true, values: ['1 kg', '2 kg', '3 kg', '5 kg', '7.5 kg', '10 kg', '15 kg', '20 kg or more'] },
  { code: 'adjustable', name: 'Adjustable', cats: [SPORTS], subs: ['Gym equipment'], kind: 'toggle', values: YES_NO },
  { code: 'wheel_size', name: 'Wheel size', cats: [SPORTS], subs: ['Cycling'], kind: 'chips', variant: true, values: ['12"', '14"', '16"', '20"', '24"', '26"', '27.5"', '29"', '700c'] },
  { code: 'gears', name: 'Gears', cats: [SPORTS], subs: ['Cycling'], kind: 'chips', values: ['Single speed', '7 speed', '18 / 21 speed', '24 speed or more'] },
  { code: 'protein_type', name: 'Protein type', cats: [SPORTS, 'Health & Pharmacy'], subs: ['Sports nutrition', 'Vitamins & supplements'], kind: 'chips', values: ['Whey', 'Whey isolate', 'Plant protein', 'Mass gainer', 'Casein', 'Soy'] },
  { code: 'age_group', name: 'Age group', cats: [SPORTS], kind: 'chips', values: ['Kids', 'Junior', 'Adult', 'All ages'] },

  // ── 27 Stationery & Office ──
  { code: 'ptype_stationery', name: 'Product type', cats: ['Stationery & Office'], kind: 'chips', values: ['Notebook', 'Long notebook', 'Diary', 'Sketch book', 'Ball pen', 'Gel pen', 'Fountain pen', 'Pencil', 'Eraser & sharpener', 'Geometry box', 'Colour pencils', 'Crayons', 'Water colours', 'Marker', 'Highlighter', 'File & folder', 'Stapler', 'Glue & tape', 'Calculator', 'A4 paper', 'Chart paper', 'Craft kit'] },
  { code: 'ruling', name: 'Ruling', cats: ['Stationery & Office'], subs: ['Notebooks & paper'], kind: 'chips', values: ['Single ruled', 'Four line', 'Unruled', 'Square / grid', 'Two line'] },
  { code: 'pages', name: 'Pages', cats: ['Stationery & Office', 'Books'], subs: ['Notebooks & paper'], kind: 'chips', values: ['Under 100', '100 – 200', '200 – 400', '400 or more'] },
  { code: 'paper_size', name: 'Paper size', cats: ['Stationery & Office'], kind: 'chips', values: ['A3', 'A4', 'A5', 'B5', 'Legal', 'Pocket'] },
  { code: 'ink_colour', name: 'Ink colour', cats: ['Stationery & Office'], subs: ['Pens & writing'], kind: 'chips', values: ['Blue', 'Black', 'Red', 'Green', 'Multicolour'] },
  { code: 'art_medium', name: 'Medium', cats: ['Stationery & Office'], subs: ['Art & craft'], kind: 'chips', values: ['Water colour', 'Acrylic', 'Oil pastel', 'Poster colour', 'Sketch pen', 'Charcoal', 'Clay'] },

  // ── 28 Toys & Games ──
  { code: 'ptype_toys', name: 'Product type', cats: ['Toys & Games'], kind: 'chips', values: ['Soft toy', 'Doll', 'Doll house', 'Action figure', 'Building blocks', 'STEM kit', 'Puzzle', 'Board game', 'Card game', 'RC car', 'RC helicopter', 'Toy car', 'Musical toy', 'Kitchen set', 'Doctor set', 'Outdoor game', 'Swing & slide', 'Ride-on', 'Tricycle', 'Bicycle (kids)'] },
  { code: 'battery_operated', name: 'Battery operated', cats: ['Toys & Games'], kind: 'toggle', values: YES_NO },
  { code: 'toy_skill', name: 'Skill', cats: ['Toys & Games'], kind: 'chips', values: ['STEM', 'Motor skills', 'Creativity', 'Problem solving', 'Language', 'Pretend play'] },
  { code: 'players', name: 'Players', cats: ['Toys & Games'], subs: ['Board games & puzzles'], kind: 'chips', values: ['1', '2', '2–4', '4 or more'] },
  { code: 'toy_material', name: 'Material', cats: ['Toys & Games'], kind: 'chips', values: ['Plastic', 'Wood', 'Plush / fabric', 'Metal', 'Rubber', 'Cardboard'] },
  { code: 'character', name: 'Character / theme', cats: ['Toys & Games', KIDS], kind: 'chips', values: ['Superhero', 'Cartoon', 'Princess', 'Cars & vehicles', 'Animals', 'Dinosaurs', 'Space'] },

  // ── 29 Watches, Eyewear & Jewellery ──
  { code: 'ptype_watches', name: 'Product type', cats: [WATCHES], kind: 'chips', values: ['Analog watch', 'Digital watch', 'Chronograph', 'Sunglasses', 'Spectacle frame', 'Chain', 'Necklace', 'Ring', 'Earrings', 'Bangles & bracelets', 'Anklet', 'Pendant', 'Mangalsutra', 'Nose pin', 'Belt', 'Wallet', 'Handbag', 'Clutch', 'Sling bag', 'Tote bag'] },
  { code: 'watch_display_type', name: 'Display', cats: [WATCHES], subs: ["Men's watches", "Women's watches"], kind: 'chips', values: ['Analog', 'Digital', 'Analog-digital'] },
  { code: 'strap', name: 'Strap', cats: [WATCHES], subs: ["Men's watches", "Women's watches"], kind: 'chips', values: ['Leather strap', 'Metal strap', 'Silicone strap', 'Fabric strap', 'Ceramic strap'] },
  { code: 'dial', name: 'Dial shape', cats: [WATCHES], subs: ["Men's watches", "Women's watches"], kind: 'chips', values: ['Round', 'Square', 'Rectangular', 'Oval', 'Tonneau'] },
  { code: 'water_resistance', name: 'Water resistance', cats: [WATCHES], subs: ["Men's watches", "Women's watches"], kind: 'chips', values: ['Not water resistant', '30 m', '50 m', '100 m or more'] },
  { code: 'movement', name: 'Movement', cats: [WATCHES], subs: ["Men's watches", "Women's watches"], kind: 'chips', values: ['Quartz', 'Automatic', 'Mechanical', 'Solar'] },
  { code: 'frame', name: 'Frame shape', cats: [WATCHES], subs: ['Sunglasses', 'Spectacle frames'], kind: 'chips', values: ['Aviator', 'Wayfarer', 'Round frame', 'Square frame', 'Rectangle frame', 'Cat eye', 'Oval frame', 'Rimless'] },
  { code: 'lens', name: 'Lens', cats: [WATCHES], subs: ['Sunglasses'], kind: 'chips', values: ['Polarised', 'UV protection', 'Mirrored', 'Gradient', 'Photochromic'] },
  { code: 'frame_material', name: 'Frame material', cats: [WATCHES], subs: ['Sunglasses', 'Spectacle frames'], kind: 'chips', values: ['Metal', 'Plastic', 'Acetate', 'Titanium', 'TR90'] },
  { code: 'metal', name: 'Metal', cats: [WATCHES], subs: ['Gold jewellery', 'Silver jewellery', 'Fashion jewellery'], kind: 'chips', values: ['Gold', 'Silver', 'Platinum', 'Gold plated', 'Silver plated', 'Brass', 'Alloy', 'Oxidised'] },
  { code: 'purity', name: 'Purity', cats: [WATCHES], subs: ['Gold jewellery', 'Silver jewellery'], kind: 'chips', values: ['24K', '22K', '18K', '14K', '925 sterling silver'] },
  { code: 'stone', name: 'Stone', cats: [WATCHES], subs: ['Gold jewellery', 'Silver jewellery', 'Fashion jewellery'], kind: 'chips', values: ['No stone', 'Diamond', 'American diamond (CZ)', 'Ruby', 'Emerald', 'Pearl', 'Kundan', 'Navaratna'] },
  { code: 'hallmark', name: 'BIS hallmark', cats: [WATCHES], subs: ['Gold jewellery', 'Silver jewellery'], kind: 'toggle', values: YES_NO },
];

/** Old codes replaced by the per-category "Product type" filters above. */
const RETIRED = ['fashion_type', 'gadget_type'];

/**
 * Values the 2026-10-27 seed made that no longer fit their filter (Men under
 * Kids' Gender, Cookware under Home's product type now that Kitchen & Dining
 * has its own). Removed only while no product or variant uses them.
 */
const PRUNE = {
  department: ['Men', 'Women'],
  fabric: ['Nylon', 'Canvas', 'Metal', 'Stainless steel'],
  os: ['Wear OS'],
  home_type: ['Table', 'Shelf', 'Cookware', 'Cutlery', 'Dinnerware', 'Storage', 'Lighting', 'Showpiece & vase', 'Cushion', 'Rug', 'Kitchen appliance', 'Cleaning'],
  beauty_type: ['Face powder'],
  sports_type: ['Equipment', 'Sportswear', 'Sports shoes', 'Fitness gear', 'Accessories', 'Outdoor'],
};

/**
 * Where each of the 300 live products goes (product id → [category, sub]),
 * worked out from their names on 2026-11-04. Ids are Neon's; ids a database
 * doesn't have are skipped.
 */
const MOVES = (() => {
  const m = {};
  const put = (cat, sub, ids) => { for (const id of ids) m[id] = [cat, sub]; };
  // Beauty
  put(BEAUTY, 'Fragrances', [246, 247, 248, 249, 250]);
  put(BEAUTY, 'Hair care', [30, 47, 46, 51, 50, 57, 53, 270]);
  put('Baby Care', 'Baby bath & skin care', [49]);
  put(BEAUTY, 'Makeup', [241, 242, 254, 265, 243, 244, 266]);
  put(BEAUTY, 'Nail care', [257, 245]);
  put(BEAUTY, 'Bath & body', [59, 54, 52, 55, 251, 252]);
  put(BEAUTY, 'Oral care', [60, 48, 58, 29, 28]);
  put(BEAUTY, 'Feminine hygiene', [56]);
  put(BEAUTY, 'Skin care', [261, 255, 269, 263, 259, 258, 267, 256, 264, 260, 262, 268]);
  put(BEAUTY, "Men's grooming", [253]);
  // Fashion
  put(WATCHES, 'Sunglasses', [192, 293, 236, 193, 237, 294, 194, 295, 238, 239, 195, 296, 196, 240, 297]);
  put(MEN, 'Shirts', [181, 299, 183, 184, 185]);
  put(MEN, 'T-shirts & polos', [300, 182]);
  put(WATCHES, "Men's watches", [191, 298]);
  put('Footwear', "Men's footwear", [288, 186, 289, 187, 188, 290, 291, 189, 190, 292]);
  put('Footwear', "Women's footwear", [202, 226, 203, 227, 228, 204, 205, 229, 230]);
  put(WOMEN, 'Dresses', [211, 197, 216, 212, 213, 214, 217, 198, 218, 199, 215, 200, 219, 201, 220]);
  put(WATCHES, 'Handbags & clutches', [206, 221, 222, 207, 223, 208, 210, 225]);
  put('Bags, Luggage & Travel', 'Backpacks', [209, 224]);
  put(WATCHES, 'Fashion jewellery', [233, 234, 235]);
  put(WATCHES, "Women's watches", [231, 232]);
  // Gadgets
  put('Electronics', 'Speakers', [77, 107, 81, 111]);
  put('Electronics', 'Headphones & earphones', [79, 109, 108, 78, 85, 115]);
  put('Electronics', 'Smartwatches & fitness bands', [84, 114]);
  put('Electronics', 'Cameras & accessories', [120, 90]);
  put(MOBILES, 'Chargers & cables', [80, 110, 82, 112]);
  put(MOBILES, 'Power banks', [83, 113]);
  put(MOBILES, 'Mobile holders & stands', [117, 87, 89, 119, 88, 118]);
  put(MOBILES, 'Cases & covers', [86, 116]);
  put(COMPUTERS, 'Laptops', [91, 92, 93, 94, 95]);
  put(COMPUTERS, 'Tablets', [97, 98, 96]);
  put(MOBILES, 'Smartphones', [65, 66, 67, 68, 99, 69, 70, 100, 73, 103, 101, 71, 102, 72, 104, 74, 105, 75, 76, 106, 63, 61, 62, 64]);
  // Grocery
  put('Grocery', 'Tea, coffee & drinks', [38, 14, 43, 19, 24, 27]);
  put('Grocery', 'Dairy, bread & eggs', [32, 8, 17, 41]);
  put('Grocery', 'Frozen food', [37, 13]);
  put('Grocery', 'Fruits & vegetables', [1, 6, 10, 34, 35, 11, 15, 39, 16, 40, 18, 42, 44, 20, 22, 25]);
  put('Household Supplies', 'Tissues & napkins', [26]);
  put('Grocery', 'Meat, fish & chicken', [2, 4, 33, 9]);
  put('Pet Supplies', 'Pet food', [3, 7, 31]);
  put('Grocery', 'Oils & ghee', [5]);
  put('Grocery', 'Sauces, pickles & spreads', [12, 36]);
  put(SPORTS, 'Sports nutrition', [45, 21]);
  put('Grocery', 'Atta, rice & dals', [23]);
  // Home
  put(HOME, 'Home decor', [156, 157, 158]);
  put('Garden & Outdoors', 'Pots & planters', [159]);
  put(HOME, 'Lighting', [160]);
  put(HOME, 'Furniture', [151, 152, 153, 154]);
  put(HOME, 'Bath', [155]);
  put('Appliances', 'Small kitchen appliances', [124, 169, 134, 129, 164]);
  put('Appliances', 'Microwave ovens', [139, 174]);
  put(KITCHEN, 'Cookware', [125, 176, 141, 179, 144]);
  put(KITCHEN, 'Glassware & drinkware', [122, 132, 167]);
  put(KITCHEN, 'Dinnerware', [177, 142]);
  put(KITCHEN, 'Serveware', [148]);
  put(KITCHEN, 'Lunch boxes', [138, 173]);
  put(KITCHEN, 'Containers & storage', [146, 140, 175]);
  put(KITCHEN, 'Cutlery', [131, 166, 147]);
  put(KITCHEN, 'Kitchen tools', [121, 123, 161, 126, 162, 127, 163, 128, 165, 130, 168, 133, 170, 135, 171, 136, 137, 172, 178, 143, 145, 180, 149, 150]);
  // Sports
  put(SPORTS, 'Football', [271, 281]);
  put(SPORTS, 'Other sports', [272, 273, 284, 282, 283]);
  put(SPORTS, 'Basketball & volleyball', [274, 275, 287]);
  put(SPORTS, 'Cricket', [276, 277, 278, 279]);
  put(SPORTS, 'Badminton', [280]);
  put(SPORTS, 'Tennis & table tennis', [285, 286]);
  return m;
})();

module.exports = { CATEGORIES, RENAMES, ATTRIBUTES, RETIRED, PRUNE, MOVES };
