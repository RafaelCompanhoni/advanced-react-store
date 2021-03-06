const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { randomBytes } = require("crypto");
const { promisify } = require("util");
const { transport, makeANiceEmail } = require("../mail");
const { hasPermission } = require("../utils");
const stripe = require("../stripe");

const Mutations = {
  async createItem(parent, args, ctx, info) {
    // check if the user is logged in
    if (!ctx.request.userId) {
      throw new Error("You must be logged in to create an item");
    }

    // creates a new item with a relationship with the current user
    const item = await ctx.db.mutation.createItem(
      {
        data: {
          user: {
            connect: {
              id: ctx.request.userId
            }
          },
          ...args
        }
      },
      info
    );

    console.log(item);

    return item;
  },
  async updateItem(parent, args, ctx, info) {
    // remove the id fom the item to be updated
    const updates = { ...args };
    delete updates.id;

    // the Prisma 'updateItem' receives the item to be updated and the 'where' clause to determine which item. Info is the query from the client-side, needed by Prisma
    return ctx.db.mutation.updateItem(
      {
        data: updates,
        where: { id: args.id }
      },
      info
    );
  },
  async deleteItem(parent, args, ctx, info) {
    const where = { id: args.id };

    // find the item
    const item = await ctx.db.query.item({ where }, `{ id title user { id }}`);

    // check if they own the item or have the permissions
    const ownsItem = item.user.id === ctx.request.userId;
    const hasPermissions = ctx.request.user.permissions.some(permission =>
      ["ADMIN", "ITEMDELETE"].includes(permission)
    );
    if (!ownsItem && hasPermissions) {
      throw new Error("You don't have permission to delete this item");
    }

    // delete it
    return ctx.db.mutation.deleteItem({ where }, info);
  },
  async signup(parent, args, ctx, info) {
    // lowercase the email
    args.email = args.email.toLowerCase();

    // hash the password (10 is the random salt length)
    const password = await bcrypt.hash(args.password, 10);

    // create the user in the database
    const user = await ctx.db.mutation.createUser(
      {
        data: {
          ...args,
          password,
          permissions: { set: ["USER"] }
        }
      },
      info
    );

    // create the JWT token (so the user doesn't need to sign in after signing up)
    const token = jwt.sign({ userId: user.id }, process.env.APP_SECRET);

    // set JWT as a cookie on the response (from now on it will come with every subsequent request)
    ctx.response.cookie("token", token, {
      httpOnly: true,
      maxAge: 1000 * 60 * 60 * 24 * 365 // 1 year
    });

    // return user obj to the client
    return user;
  },
  async signin(parent, { email, password }, ctx, info) {
    // check if there is a user with that email
    const user = await ctx.db.query.user({ where: { email } });
    if (!user) {
      throw new Error(`No such user found for email ${email}`);
    }

    // check if the password is correct
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
      throw new Error("Invalid password");
    }

    // generate the JWT token
    const token = jwt.sign({ userId: user.id }, process.env.APP_SECRET);

    // set the cookie with the token
    ctx.response.cookie("token", token, {
      httpOnly: true,
      maxAge: 1000 * 60 * 60 * 24 * 365
    });

    return user;
  },
  async signout(parent, { email, password }, ctx, info) {
    ctx.response.clearCookie("token");
    return { message: "Logged out" };
  },
  async requestReset(parent, args, ctx, info) {
    // check if it's a registered user
    const user = await ctx.db.query.user({ where: { email: args.email } });
    if (!user) {
      throw new Error(`No such user found for email ${email}`);
    }

    // set a reset token and expiry date
    const randomBytesPromisified = promisify(randomBytes);
    const resetToken = (await randomBytesPromisified(20)).toString("hex");
    const resetTokenExpiry = Date.now() + 3600000; // reset token expires in 1 hour from now

    const res = await ctx.db.mutation.updateUser({
      where: { email: args.email },
      data: { resetToken, resetTokenExpiry }
    });

    // email the user the reset token
    const mailResponse = await transport.sendMail({
      from: "companhoni@gmail.com",
      to: user.email,
      subject: "Your password reset token",
      html: makeANiceEmail(
        `Your password reset token is here \n\n <a href="${
          process.env.FRONTEND_URL
        }/reset?resetToken=${resetToken}">Click here to reset</a>`
      )
    });

    return { message: "reset token successfully generated" };
  },
  async resetPassword(parent, args, ctx, info) {
    // check if the passwords match
    if (args.password !== args.confirmPassword) {
      throw new Error("The informed passwords don't match");
    }

    // check if it's a legit reset token and it's not expired
    console.log(`CHECKING THE TOKEN ${args.resetToken}`);
    const [user] = await ctx.db.query.users({
      where: {
        resetToken: args.resetToken,
        resetTokenExpiry_gte: Date.now() - 3600000
      }
    });

    if (!user) {
      throw new Error("This token is is either invalid or expired");
    }

    // hash the new password and update the user with it
    const password = await bcrypt.hash(args.password, 10);
    const updatedUser = await ctx.db.mutation.updateUser(
      {
        where: { email: user.email },
        data: {
          password,
          resetToken: null,
          resetTokenExpiry: null
        }
      },
      info
    );

    // generate the JWT token and set the cookie with it
    const token = jwt.sign({ userId: updatedUser.id }, process.env.APP_SECRET);
    ctx.response.cookie("token", token, {
      httpOnly: true,
      maxAge: 1000 * 60 * 60 * 24 * 365
    });

    return updatedUser;
  },
  async updatePermissions(parent, args, ctx, info) {
    // check if the current user is logged in
    if (!ctx.request.userId) {
      throw new Error("You must be logged in");
    }

    // query the current user
    const currentUser = await ctx.db.query.user(
      { where: { id: ctx.request.userId } },
      info
    );

    // check if the current user has the permissions to update permissions
    hasPermission(currentUser, ["ADMIN", "PERMISSIONUPDATE"]);

    // update the informed user's permission (which not necessarily is the current user -- see the Permissions table component at the FE)
    return ctx.db.mutation.updateUser(
      {
        data: { permissions: { set: args.permissions } },
        where: { id: args.userId }
      },
      info
    );
  },
  async addToCart(parent, args, ctx, info) {
    // is the user signed in
    const { userId } = ctx.request;
    if (!userId) {
      throw new Error("You must be signed in");
    }

    // query the users current cart
    const [existingCartItem] = await ctx.db.query.cartItems({
      where: {
        user: { id: userId },
        item: { id: args.id }
      }
    });

    // check if that item is already in their cart and increment 1 if it is
    if (existingCartItem) {
      console.log("This item is already in their cart");
      return ctx.db.mutation.updateCartItem(
        {
          where: { id: existingCartItem.id },
          data: { quantity: existingCartItem.quantity + 1 }
        },
        info
      );
    }

    // if not, create a new CartItem for the user
    return ctx.db.mutation.createCartItem(
      {
        data: {
          user: {
            connect: { id: userId }
          },
          item: {
            connect: { id: args.id }
          }
        }
      },
      info
    );
  },
  async removeFromCart(parent, args, ctx, info) {
    // find cart item
    const cartItem = await ctx.db.query.cartItem(
      {
        where: { id: args.id }
      },
      `{id, user { id }}`
    );

    if (!cartItem || cartItem.user.id !== ctx.request.userId) {
      throw new Error("No cart item found");
    }

    // delete the cart item
    return ctx.db.mutation.deleteCartItem({ where: { id: cartItem.id } }, info);
  },
  async createOrder(parent, args, ctx, info) {
    // make sure current user is signed in
    const { userId } = ctx.request;
    if (!userId) {
      throw new Error("You must be signed in to complete this order");
    }

    const user = await ctx.db.query.user(
      { where: { id: userId } },
      `{
        id
        name
        email
        cart {
          id
          quantity
          item { title price id description image largeImage }
        }
      }`
    );

    // calculate again the total price (we can't simply use the value coming from the FE since it could have been altered)
    const amount = user.cart.reduce(
      (tally, cartItem) => tally + cartItem.item.price * cartItem.quantity,
      0
    );

    // create the stripe charge
    const charge = await stripe.charges.create({
      amount,
      currency: 'USD',
      source: args.token
    })

    // convert CartItems to OrderItems
    const orderItems = user.cart.map(cartItem => { 
      const orderItem = {
        ...cartItem.item,
        quantity: cartItem.quantity,
        user: {
          connect: { id: userId }
        }
      };

      delete orderItem.id;
      return orderItem;
    });

    // create the Order
    const order = await ctx.db.mutation.createOrder({
      data: {
        total: charge.amount,
        charge: charge.id,
        items: { create: orderItems },
        user: {
          connect: { id: userId }
        }
      }
    });

    // clear the users cart
    const cartItemIds = user.cart.map(cartItem => cartItem.id);
    await ctx.db.mutation.deleteManyCartItems({
      where: { id_in: cartItemIds }
    });

    // return the order to the client
    return order;
  }
};

module.exports = Mutations;
