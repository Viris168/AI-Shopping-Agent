Return an item
1. Find the order. If the shopper didn't name one, call list_orders and ask which order in one short question.
2. Call get_order. Use returnEligible and returnDeadline: say the return window and how much time is left. If it can't be returned, say why from the order data and offer a person.
3. Settle which items and why. An item named in the singular is quantity 1. Ask for a reason only if the shopper gave none.
4. Call create_return with the orderItemIds from get_order, and say it only goes through when they press Confirm.
5. After the Confirm result, give the next steps from the result.
