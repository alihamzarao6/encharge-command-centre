# Connecting your AI to the Command Centre

This lets your own AI — Grok — look at your Finance Pipeline: the same leads, stages and
details you see in the Command Centre. Once it is connected you can ask it about your leads
in plain words and it will look them up for you.

**For now it can look, not touch.** It can read your leads. It cannot move a lead, add a
note or change anything. That comes next, once we know the connection works for you.

---

## What you need

Two things, both from us:

1. **The address**

   `https://fundd-command-centre.vercel.app/mcp`

   *(This will change to your own web address once your domain is set up. We will tell you
   when, and you will only need to swap this one line.)*

2. **Your key**

   A long line of letters and numbers that starts with `fcc_`. We send it to you once.
   It works like a password for your AI, so:

   - keep it somewhere safe, like your password manager;
   - do not paste it into an email, a text, or a chat with anyone;
   - if you lose it, or think someone else has seen it, tell us. We switch it off and give
     you a new one. That takes a minute.

---

## Setting it up in Grok

1. Open Grok and go to **Connectors** (`grok.com/connectors`).
2. Choose to add your own connector. Grok calls this a **custom connector**; you may also
   see it called **"Bring your own MCP"**.
3. Where it asks for the **address** (it may say "URL" or "server URL"), paste the address
   above.
4. Where it asks for a **key** (it may say "token", "API key", "authorization" or "bearer
   token"), paste your key.
5. Give it a name you will recognise, such as **Fundd Command Centre**, and save.

When it has connected, Grok should show four things it can now do: a **pipeline summary**,
**list leads**, **get one lead** and **search leads**.

### If Grok never asks you for a key

Stop there and tell us what you see on the screen — a photo of it is perfect.

Some versions of Grok ask only for the address and then try to sign you in a different way.
If yours does that, nothing is broken and nothing is at risk; it means we need to add that
kind of sign-in on our side. We would rather know than have you spend an evening on it.

---

## What you can ask it

Ask the way you would ask a person. For example:

- *"How many open leads have I got, and where are they sitting?"*
- *"Who came in this week?"*
- *"Show me everyone in Appointment Booked."*
- *"Find the lead called Sarah Nguyen."*
- *"Whose number is 0412 345 678?"*
- *"What did the Johnsons put on their enquiry form?"*
- *"What notes have we got on that lead?"*

It can tell you:

- how many leads are in each stage, and how many are new this week;
- your leads, newest first — by stage, or open, won or lost;
- everything about one lead: their stage, their name, email and phone, what they answered
  on the enquiry form, and the latest notes your team wrote in the Command Centre;
- who a name, an email address or a phone number belongs to.

---

## Three things worth knowing

**It sees a copy, and the copy has a time on it.** The Command Centre keeps a copy of your
pipeline from GoHighLevel. That copy is brought up to date when you press **Refresh** in the
Command Centre. Your AI is told how old the copy is every time it looks, and it should tell
you. If you have just moved a lead in GoHighLevel and your AI has not caught up, open the
Command Centre, press Refresh, and ask again.

**It sees only the Finance Pipeline.** Nothing else in your GoHighLevel account is visible
to it.

**Notes written straight into GoHighLevel are not there yet.** It can see the notes your
team writes in the Command Centre. A note someone typed directly into GoHighLevel will not
show up.

---

## What your AI receives

When you ask a question, the answer to it leaves the Command Centre and goes to Grok, so
that Grok can read it to you. That means lead names always, and — when you ask about one
particular lead — that person's email, phone number, form answers and notes.

We send only what the question needs: a list shows names and stages, never emails or phone
numbers. Those are sent one lead at a time, when you ask about that lead.

What Grok does with what it has been told is between you and Grok. It is worth a look at
its privacy settings, the same as you would for any service that handles your clients'
details.

---

## If something goes wrong

| What you see | What it means | What to do |
|---|---|---|
| "Not authorised" | The key is wrong, or has been switched off | Check you pasted the whole key, with nothing before or after it. If it still fails, ask us for a new one |
| "Too many requests" | Your AI asked too many times in a minute | Wait a minute and ask again. If it keeps happening, tell us |
| "Has not copied this pipeline yet" | The Command Centre has never been refreshed | Open the Command Centre and press Refresh |
| It tells you something out of date | The copy is old | Press Refresh in the Command Centre, then ask again |
| Grok says it cannot connect | Could be the address, or how Grok signs in | Send us what is on the screen |

Anything else: send us a photo of the screen and what you had just asked. That is all we
need to find it.
