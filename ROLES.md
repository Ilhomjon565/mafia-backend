# Mafia — Rollar va qoidalar (performance_arts)

Ushbu hujjat o'yin rollari va mexanikasining yagona manbasi (source of truth).

## Tomonlar

### 1) 👨🏼 Tinch aholi tomoni (Town)
- **👨🏼 Tinch aholi** — Maxsus kuchi yo'q. Maqsad: mafiyani topib, kunduzgi ovozda osish.
- **💃 Kezuvchi (Ma'shuqa)** — Bir kechada bitta o'yinchini "band qiladi" (uxlatadi → o'sha kecha harakatini bekor qiladi). Komissar bilan birga bo'la olmaydi, Komissarni uxlata olmaydi.
- **👮🏻‍♂ Serjant** — Komissarga yordamchi. Komissar harakatlaridan xabardor bo'ladi. Komissar o'lsa, uning o'rnini egallaydi (Komissarga aylanadi).
- **🕵🏻‍♂ Komissar Kattani** — Shaharning asosiy himoyachisi. Tunda o'yinchini tekshiradi (mafiyami?). Mafiyani topsa kunduzgi ovozда osishga harakat qiladi / otadi. **Birinchi tunda tekshirmasdan otish taqiqlanadi.**
- **👨🏻‍⚕ Doktor** — Komissar o'zini e'lon qilgandan keyin uni davolaydi. O'zini faqat **bir marta** davolay oladi.
- **🧙‍♂ Daydi** — Tunda bitta o'yinchi oldiga boradi (shisha butilka uchun) va qotillikka guvoh bo'ladi.
- **🧞‍♂️ Afsungar** — Tunda o'ldirilsa, o'ldirgan o'yinchini **o'zi bilan olib ketadi** (ikkalasi o'ladi). Kunduzi ovozда o'ldirilsa, o'zi xohlagan bitta o'yinchini o'ldiradi.

### 2) 🤵🏼 Mafiya tomoni (Mafia)
- **🤵🏻 Don** — Mafiya boshlig'i. Tunda kimni o'ldirishni hal qiladi.
- **🤵🏼 Mafiya** — Tunda Don bilan birga nishonni tanlaydi.
- **👨‍💼 Advokat** — Tunda kimnидir himoya qiladi. Agar Mafiyani tanlasa, Komissar tekshirganda u **Tinch aholi** bo'lib ko'rinadi. Maqsad — Mafiya g'alabasi.

### 3) Betaraf (Neutral)
- **🔪 Qotil** — Tunda atrofdagilarni o'ldiradi. **Faqat yakkama-yakka qolsa g'olib bo'ladi.**
- **🐺 Bo'ri** — Ikki tomonlama; reenkarnatsiya qiladi:
  - Mafiya (Don) o'ldirsa → keyingi kecha **Mafiya** bo'ladi.
  - Komissar o'ldirsa → **Serjant**ga aylanadi.
  - Qotil o'ldirsa → **o'ladi**.

## Ochiq savollar (aniqlanishi kerak)
1. Har o'yinda qaysi rollar / nechtadan? (o'yinchi soniga qarab jadval? host tanlaydimi? random pool?)
2. Tungi harakatlar tartibi (masalan: Kezuvchi blok → Advokat himoya → Don/Mafiya o'ldirish → Komissar otish/tekshirish → Doktor davolash → Daydi/Afsungar effektlari)?
3. G'alaba shartlari aniq formulasi (Town / Mafia / Qotil / Bo'ri holatlari).
4. Komissarning "otish" — kunduzi ovozда maxsus huquqmi yoki tunda otishmi?
5. Kezuvchi bloki qaysi rollarga ta'sir qiladi?

> Eslatma: hozirgi backend faqat 4 rol (mafia/sheriff/doctor/civil) bilan ishlaydi. Bu to'liq qayta qurishni talab qiladi.
