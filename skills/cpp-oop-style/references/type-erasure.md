# Type Erasure

Load this reference only when an API must expose one concrete wrapper over
unrelated value types that cannot share a public base class.

## Distinguish subtype hiding from type erasure

Returning `std::unique_ptr<Animal>` from `makeDog()` hides `Dog` from the
function signature, but it is still ordinary runtime polymorphism: every
implementation derives from `Animal`.

Type erasure removes that inheritance requirement. The public wrapper owns a
private virtual interface; a templated model adapts each unrelated value type to
it. The wrapper is a value/resource type, while wrapped types remain plain data.

Choose the smallest mechanism that fits:

- One call signature: `std::function`, or C++23 `std::move_only_function`.
- Storage with no shared operations: `std::any`.
- Closed set of known types: `std::variant` and `std::visit`.
- Types you own with natural identity: a normal abstract interface.
- Several operations over unrelated types: custom type erasure.

## C++17-compatible move-only wrapper

A named factory avoids a forwarding constructor, its self-type constraint, and
the associated C++20 `requires` ceremony:

```cpp
struct Dog { std::string name; };

void animalSpeak(Dog const &dog) {
    std::cout << dog.name << " barks\n";
}

struct AnyAnimal {
    template <class T>
    static AnyAnimal from(T value) {
        return AnyAnimal{std::make_unique<Model<T>>(std::move(value))};
    }

    AnyAnimal(AnyAnimal &&) noexcept = default;
    AnyAnimal &operator=(AnyAnimal &&) noexcept = default;
    AnyAnimal(AnyAnimal const &) = delete;
    AnyAnimal &operator=(AnyAnimal const &) = delete;

    void speak() const { self->speak(); }

private:
    struct Interface {
        virtual ~Interface() = default;
        virtual void speak() const = 0;
    };

    template <class T>
    struct Model final : Interface {
        explicit Model(T value_) : value(std::move(value_)) {}
        void speak() const override { animalSpeak(value); }
        T value;
    };

    explicit AnyAnimal(std::unique_ptr<Interface> self_)
        : self(std::move(self_)) {}

    std::unique_ptr<Interface> self;
};

auto animal = AnyAnimal::from(Dog{"George"});
animal.speak();
```

The free `animalSpeak` overload is the non-intrusive extension point: add an
overload beside a new value type without modifying the wrapper.

## Copy and cost policy

Keep the wrapper move-only unless callers genuinely need value copies. For a
copyable wrapper, add `virtual std::unique_ptr<Interface> clone() const` and let
each `Model<T>` copy its stored value. Do not substitute `shared_ptr` merely to
make copying compile; that changes value copies into shared identity.

This basic form allocates one model per wrapper. If measurement shows that cost
matters, first reconsider `variant` or an intrusive interface. Implement
small-buffer optimization only when the extra lifetime, alignment, and move
machinery is justified by a benchmark.
