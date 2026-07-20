import { configureStore } from "@reduxjs/toolkit";
import { setupListeners } from "@reduxjs/toolkit/query";
import { api } from "./api.ts";
import { apiErrorMiddleware } from "./errorMiddleware.ts";

export const store = configureStore({
  reducer: { [api.reducerPath]: api.reducer },
  // apiErrorMiddleware — страхувальна сітка: показує toast на будь-якому впалому запиті,
  // щоб сторінка не могла «мовчки спорожніти» (див. коментар у файлі).
  middleware: (getDefault) => getDefault().concat(api.middleware, apiErrorMiddleware),
});

setupListeners(store.dispatch);

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;
