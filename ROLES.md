# Mafia — Rollar va qoidalar

Ushbu hujjat oʻyin rollari va mexanikasining yagona manbasi (source of truth).
Mexanikaning sof mantiqiy qismi `rules.js` da, testlari `rules.test.mjs` da
(`npm test` bilan ishga tushadi) — hujjat va kod bir-biriga mos boʻlishi shart.

## Tomonlar

### 1) 👨🏼 Tinch aholi tomoni (town)

| Rol | Tunda | Izoh |
|---|---|---|
| 👨🏼 **Tinch aholi** | — | Maxsus kuchi yoʻq. Yagona quroli — mantiq va ovoz. |
| 💃 **Kezuvchi** | Bitta oʻyinchini band qiladi | Band qilingan oʻyinchining oʻsha kechagi harakati bekor boʻladi. **Komissarni band qila olmaydi.** Oʻzini tanlay olmaydi. |
| 👮🏻‍♂ **Serjant** | — | Komissarning tekshiruv natijalarini koʻradi. Komissar oʻlsa (tunda ham, kunduzi ovoz bilan ham) **avtomatik Komissarga aylanadi**. |
| 🕵🏻‍♂ **Komissar** | Tekshiradi **yoki** otadi | Tekshiruv natijasi kunduzi keladi. **Birinchi tunda otish taqiqlanadi**. Oʻzini tekshira ham, ota ham olmaydi. Komissar oʻqini doktor ham, qalqon ham, qoʻshimcha jon ham toʻxtata olmaydi. |
| 👨🏻‍⚕ **Doktor** | Bitta oʻyinchini oʻlimdan qutqaradi | Oʻzini butun oʻyin davomida **faqat bir marta** davolay oladi. Bu huquq davolash HAQIQATAN sodir boʻlganda sarflanadi — Kezuvchi bloklasa yoʻqolmaydi. |
| 🧙‍♂ **Daydi** | Bitta oʻyinchi oldiga boradi | Oʻsha uyda qotillik sodir boʻlsa — **kim oʻldirganini koʻradi**. Qotil va Komissar yakka harakat qilgani uchun ularning **ismi** koʻrsatiladi; mafiya jamoa boʻlib oʻldirgani uchun faqat "Mafiya" yorligʻi beriladi. Qurbon qutqarilgan boʻlsa (doktor/qalqon/qoʻshimcha jon) Daydi **hech narsa koʻrmaydi** — u faqat oʻlimga guvoh boʻladi. Natija kunduzi keladi. |
| 🧞‍♂ **Afsungar** | — | Tunda oʻldirilsa — **oʻldirganni oʻzi bilan olib ketadi**. Kunduzi ovoz bilan chiqarilsa — **oʻzi tanlagan** bitta oʻyinchini olib ketadi (tanlash uchun natija fazasi 15 soniyaga choʻziladi; tanlamasa hech kim oʻlmaydi). Qasos oddiy oʻlim kabi hisoblanadi: qalqon, doktor va qoʻshimcha jon undan ham himoya qiladi. |

### 2) 🤵🏼 Mafiya tomoni (mafia)

| Rol | Tunda | Izoh |
|---|---|---|
| 🤵🏻 **Don** | Nishonga ovoz beradi | Mafiya boshligʻi. Kelishuv boʻlmasa **yakuniy qarorni Don qabul qiladi**. |
| 🤵🏼 **Mafiya** | Nishonga ovoz beradi | Don bilan birga nishonni tanlaydi. |
| 👨‍💼 **Advokat** | Bitta oʻyinchini himoya qiladi | Himoyalangan mafiya Komissar tekshirganda **Tinch aholi** boʻlib koʻrinadi. Oʻldirish ovoziga **qatnashmaydi** (alohida bosqichda harakat qiladi). |

**Nishon tanlash tartibi:** hamma bir xil nishonni tanlasa — oʻsha oʻladi. Kelisha olmasa
Don qarori kuchga kiradi. Don yoʻq (oʻlgan yoki uzilib qolgan) boʻlsa — koʻpchilik ovozi;
ovozlar teng boʻlsa hech kim oʻlmaydi. Uzilib qolgan mafiya kutilmaydi.

### 3) Betaraf (neutral)

| Rol | Tunda | Gʻalaba sharti |
|---|---|---|
| 🔪 **Qotil** | Bitta oʻyinchini oʻldiradi | **Faqat yakkama-yakka qolsa** gʻolib. U tirik ekan boshqa hech kim yakuniy gʻalaba qila olmaydi. |
| 🐺 **Boʻri** | — | Omon qolish roli. Mafiya oʻldirsa → **Mafiya** boʻladi; Komissar otsa → **Serjant** boʻladi (xonada Serjant allaqachon boʻlsa → **Tinch aholi**); Qotil oʻldirsa → **oʻladi**. Kunduzgi ovozda chiqarilsa yoki Afsungar oʻzi bilan olib ketsa — qayta tugʻilmaydi, oddiy oʻladi. Oʻyin oxirida tirik boʻlsa — gʻolib hisoblanadi. Faqat boʻri(lar) qolsa — boʻri tomoni yutadi. |

## Tungi bosqichlar tartibi

Tun navbat bilan oʻtadi; har bosqichda faqat oʻsha rol harakat qiladi:

1. 🤵 **Mafiya** — nishon tanlash
2. 🕵🏻‍♂ **Komissar** — tekshirish yoki otish
3. 👨🏻‍⚕ **Doktor** — davolash
4. 💃 **Kezuvchi** — band qilish
5. 👨‍💼 **Advokat** — himoya
6. 🔪 **Qotil** — oʻldirish
7. 🧙‍♂ **Daydi** — borish

Rol oʻyinda boʻlmasa, bosqich qisqa oʻtib ketadi. Qaysi rollar oʻyinda ekani
oʻyin boshida **hammaga ochiq** koʻrsatiladi (klassik mafiyada host eʼlon qilganidek) —
busiz bosqich tezligidan baribir bilinardi.

**Natijalar hal qilinish tartibi:** Kezuvchi bloki → Advokat himoyasi → Mafiya oʻqi →
Qotil oʻqi → Komissar (tekshirish/otish) → Doktor davolashi → oʻlimlar hisoblanadi →
Daydi guvohligi → Serjant koʻtarilishi.

Bir oʻyinchiga bir kechada ikki hujum tushsa, qalqon/doktor/qoʻshimcha jon **bir marta**
ishlaydi (ikkalasini ham toʻxtatadi va buyum bir marta sarflanadi).

## Gʻalaba shartlari

Har bir holat aniq yakunlanadi — oʻyin hech qachon muzlab qolmaydi:

| Holat | Natija |
|---|---|
| Hech kim tirik qolmadi | **Durang** |
| Faqat qotil(lar) qoldi | **Qotil** |
| Faqat boʻri(lar) qoldi | **Boʻri** |
| Qotil tirik | Hali hech kim yutmaydi |
| Mafiya soni qolganlarga teng yoki koʻp | **Mafiya** |
| Mafiya ham, qotil ham qolmadi | **Tinch aholi** |

Tirik Boʻri shahar gʻalabasiga toʻsqinlik qilmaydi — u tomon emas, omon qolish roli.

## Rol balansi

- Oʻyin kamida **5 kishi** bilan boshlanadi. 3–4 kishida birinchi ovozning oʻzidayoq
  gʻolib aniqlanib qoladi va tun mexanikasi umuman ishlamaydi.
- Mafiya **har doim ozchilik**: `mafiya × 2 < oʻyinchilar soni`.
- Noyob rollar (Komissar, Don, Doktor, Serjant, Kezuvchi, Daydi, Afsungar, Advokat,
  Qotil, Boʻri) xonada **faqat bittadan** boʻladi; faqat oddiy Mafiya va Tinch aholi
  koʻp boʻlishi mumkin.
- Serjant Komissarsiz tarqatilmaydi.
- Host qoʻlda tanlagan tarkib **haqiqiy oʻyinchi soniga moslanadi**: kam odam yigʻilsa
  ortiqcha rollar ahamiyati boʻyicha kesiladi (Boʻri → Afsungar → Daydi → Qotil → …),
  mafiya ulushi esa ozchilikda qoladi.

## Buyumlar

| Buyum | Taʼsir |
|---|---|
| 🛡️ Qalqon | Bir kechaga oʻlimdan himoyalaydi (Komissar oʻqidan tashqari) |
| 🔍 Lupa | Bitta **tirik** oʻyinchining rolini ochadi (oʻzini tanlab boʻlmaydi) |
| ❤️ Qoʻshimcha jon | Oʻlimdan bir marta qutqaradi — tunda ham, kunduzgi ovozda ham |

## Ochiqlik qoidasi

Oʻyin davomida **ochiq jurnalda** faqat shahar baribir biladigan narsalar koʻrinadi:
oʻlimlar, ovoz natijasi, kimdir omon qolgani. Kim kimni davolagani, kim kimni band
qilgani, Komissar nimani koʻrgani, Boʻri kimga aylangani — **maxfiy jurnalga** yoziladi
va faqat oʻyin tugagach ochiladi.
