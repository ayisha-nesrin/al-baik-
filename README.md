# Albake Bytes Cafe — seat delivery ordering

Customers scan the QR code on their seat, order, pay (online or at the seat) and watch their order status. Every order appears instantly in the cafe app.

| App | Address | Who uses it |
|---|---|---|
| Customer app | `https://your-site/` (QR codes add `?seat=S1-H12`) | Audience |
| Cafe app | `https://your-site/cafe` | Cafe staff (PIN protected) |

## 1. Your menu
**Option A — before deploying:** open `menu.csv` in Excel or Google Sheets, replace the sample rows with your menu, and save as CSV. It is loaded the first time the server starts.

| Column | Required | Example |
|---|---|---|
| category | yes | Snacks |
| name | yes | Veg Puff |
| price | yes | 30 (rupees, no symbol needed) |
| description | no | Kerala bakery style |
| veg | no | yes / no (default yes) |
| emoji | no | 🥟 (shown when there's no photo) |
| available | no | yes / no (default yes) |

**Option B — any time after deploying:** cafe app → **Menu** tab:
- **+ Add item**, or tap any item to edit its name, price, category or description, add a **photo**, or delete it
- ↑ ↓ to reorder items and categories
- **In stock** tick box: untick when something runs out
- **Import spreadsheet**: upload a CSV with the columns above, either to add/update items or to replace the whole menu
- **Download menu**: get the current menu as a spreadsheet

After the first start, menu changes are made in the cafe app (editing `menu.csv` again has no effect unless you import it).

## 2. Cafe app
- **Orders**: live orders with seat, items, note and a **Paid online** or **Collect ₹X** badge. Tap *Send out*, then *Delivered*. Turn on sound for a chime. **Download sales** gives any day's orders as a spreadsheet.
- **Menu**: as above.
- **Seat QR**: generate and print a QR code for every seat.

## 3. Run on your computer
Requires Node.js 18 or newer.
```
npm install
STAFF_PIN=5678 npm start
```
Windows PowerShell: `$env:STAFF_PIN="5678"; npm start`
Open http://localhost:3000 (customer) and http://localhost:3000/cafe (cafe).

## 4. Deploy on Render
1. Put this folder in a GitHub repository.
2. render.com → **New → Web Service** → choose the repo.
3. Build command `npm install`, start command `npm start`.
4. Add environment variables (below), at least `STAFF_PIN`.
5. Add a **Persistent Disk** (mount path `/var/data`) and set `DATA_DIR=/var/data`. This keeps orders, menu changes and photos. Without it they reset on every restart or redeploy.
6. Open `/cafe` → **Seat QR**, check the address is your live site, then print.

Railway, Fly.io or any VPS also work (attach a volume, point `DATA_DIR` at it). A Dockerfile is included.

## Settings (environment variables)
| Name | Default | Meaning |
|---|---|---|
| `STAFF_PIN` | `1234` | PIN for the cafe app. **Change this.** 10 wrong tries locks that device out for 15 minutes |
| `CAFE_NAME` | `Albake Bytes Cafe` | Shown in both apps and the payment window |
| `DATA_DIR` | `./data` | Where the database and photos are stored |
| `DELIVERY_FEE` | `20` | Seat delivery fee in ₹ (0 for free) |
| `GST_RATE` | `0.05` | GST as a fraction (0.05 = 5%) |
| `PAY_AT_SEAT` | `on` | `off` = every order must be paid online |
| `RAZORPAY_KEY_ID` | | Turns on "Pay now" |
| `RAZORPAY_KEY_SECRET` | | Never share this or put it in a web page |
| `RAZORPAY_WEBHOOK_SECRET` | | Secret you choose when creating the webhook |

## 5. Razorpay online payment
1. dashboard.razorpay.com → switch on **Test Mode** → **Account & Settings → API Keys → Generate Test Key**.
2. Set `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET` and restart.
3. **Account & Settings → Webhooks → Add New Webhook**: URL `https://your-site/api/razorpay/webhook`, a secret of your choice (also set it as `RAZORPAY_WEBHOOK_SECRET`), events `payment.captured` and `order.paid`. This confirms payments even if a customer's phone loses signal after paying.
4. Test with UPI ID `success@razorpay`. No real money moves.
5. Go live: finish Razorpay KYC, generate **Live** keys, replace both keys, and add the webhook again in Live mode.

Orders paid online reach the cafe only after Razorpay confirms the payment. Unpaid online orders are closed automatically after 2 hours.
